"""Render the planner prompt and turn a backend's response into a `Plan`.

Ports `auto-run.sh:610-689` (contract `01` §4): the exact user-prompt
template, plus the single-shot dispatch (`ask_llm_json` -> `llm_json` ->
`_llm_raw`) that sends `personality.md` as the **system** prompt and this
rendered text as the **user** prompt, for all three backends.

Every literal heading, the full-width punctuation, the em dash, the `---`
separator, and the JSON action-shape catalogue are copied byte for byte from
the script. See `render_planner_prompt`'s docstring for a historical note on
a bash 3.2 defect this module never reproduced, fixed upstream in `auto-run.sh`
by commit `97b3021`.
"""

from __future__ import annotations

from swil_agent.llm.base import Backend, BackendUnavailableError, CompletionRequest, complete_json
from swil_agent.llm.extract import normalize_plan
from swil_agent.models import ActContext, Persona, Plan

# ── section headings (contract 01 §4, verbatim) ─────────────────────────────

_FEED_HEADING = "## 关联话题动态（你关注的话题的近期帖子，可用于互动或获取灵感）"
_NOTIFICATION_HEADING = "## 我的未读通知（最新8条，可据此决定是否回应）"
_MEMORY_HEADING = "## 最近行动记录（最新20条）"
_ENGAGED_HEADING = "## 你最近已经互动过的帖子 ID（最近 7 天）"
_ENGAGED_WARNING = (
    "**禁止再次对这些 postId 选择 like 或 comment** — 即使再次出现在 feed 里也跳过，避免重复打扰。"
)
_STATS_HEADING = "## 发帖统计"
_RHYTHM_HEADING = "## 本轮节律约束"
_GLOBAL_FEED_HEADING = "## 平台最新帖子（推荐流，可用于回应、点赞、转发等）"
_TIMELINE_HEADING = "## 平台时间线（按时间倒序，含更早的帖子，给你更宽的视野）"

# The thread block's own heading + the three instructional lines that follow
# it (auto-run.sh:641-644) — this is the ONLY text in the whole prompt that
# tells the model `parentId` comes from the `[24位ID]` shown before each
# comment in the thread dump below it. Do not paraphrase.
_THREAD_SECTION_HEADER = (
    "## 正在进行的讨论（几条热帖的完整评论区）\n"
    "下面每条评论前面的 [24位ID] 就是它的 commentId。想接着某条评论往下说，\n"
    '就用 {"action":"comment","postId":"该帖ID","parentId":"该评论ID","text":"..."}。\n'
    "不感兴趣就跳过——不必为了用上这块内容而硬接话。"
)

_CONTACTS_HEADING = "## 可以私信的人（只有这些人；写名单外的人会被丢弃）"
_DM_HEADING = "## 最近的私信会话"

# ── invariant tail (contract 01 §4, auto-run.sh:654-687, verbatim) ─────────
#
# Split into three plain-concatenation pieces around the one variable
# (action_budget) so nothing here ever goes through `str.format`/f-string
# substitution -- the JSON action-shape catalogue is full of literal `{`/`}`
# characters, and running that text through a formatter would mean escaping
# every one of them (`{{`, `}}`), which is exactly the kind of transcription
# risk the byte-for-byte requirement exists to rule out. Plain `+` never
# touches those characters at all.

_TAIL_HEAD = (
    "---\n"
    "请根据你的性格、行为规则和「发帖节律」，决定这一轮要做什么。\n"
    "\n"
    "上面的“本轮节律约束”是硬规则，不要违背。\n"
)

_TAIL_BUDGET_PREFIX = "你这一轮有 "

_TAIL_BODY = (
    " 个动作的预算。按你的性格决定这一轮做哪些事——\n"
    "可以只做一件，也可以做满预算。别硬凑数量，但也别只发一条帖子就走。\n"
    "\n"
    "硬规则（违反的动作会被直接丢弃）：\n"
    "- 最多 1 条 post，最多 1 条 echo；其余预算必须花在互动上"
    "（comment / reply / like / follow / dm）\n"
    "- 私信只能发给上面「可以私信的人」名单里的人\n"
    "- 同一条帖子不要重复做同一个动作\n"
    "\n"
    "**只输出一个合法的 JSON 对象，不要有任何其他文字：**\n"
    "\n"
    '{"plan":[ ...按你想执行的顺序排列的动作... ]}\n'
    "\n"
    "每个动作的格式：\n"
    '发帖（纯文字）：{"action":"post","text":"你的帖子内容"}\n'
    '发帖（带图片）：{"action":"post","text":"你的帖子内容",'
    '"imageTopic":"english keyword for image search"}\n'
    '评论帖子：{"action":"comment","postId":"帖子的24位ID","text":"评论内容"}\n'
    '回复评论：{"action":"comment","postId":"帖子的24位ID","parentId":"评论的24位ID",'
    '"text":"回复内容"}\n'
    '点赞：{"action":"like","postId":"帖子的24位ID"}\n'
    '转发（纯转发）：{"action":"echo","postId":"帖子的24位ID"}\n'
    '引用转发（带你的评价）：{"action":"echo","postId":"帖子的24位ID","text":"你的引用语"}\n'
    '关注：{"action":"follow","username":"用户名（不带@）"}\n'
    '私信：{"action":"dm","username":"用户名（不带@）","text":"私信内容"}\n'
    '这一轮什么都不做：{"plan":[{"action":"nothing"}]}\n'
    "\n"
    "imageTopic 说明：可选字段，填写与帖子内容相关的英文关键词（如 "
    '"technology"、"nature"、"city night"），系统会自动配图。不想配图时省略此字段即可。\n'
    "parentId 说明：回复通知中的评论时使用，填写通知里的评论ID（24位十六进制）。\n"
    "follow 说明：当 feed 里反复出现某个值得长期关注的用户时使用；同一个用户不要重复关注"
    "（你已经关注的人不会重复出现互动通知里）。\n"
    "dm 说明：私信是私下说话，不是公开发言。用在只想对一个人说、不适合放在帖子下面的时候；"
    "对方看得到你的名字。"
)


def render_planner_prompt(ctx: ActContext, *, rhythm_guidance: str) -> str:
    """Render the exact user prompt `auto-run.sh` builds at lines 610-689.

    Each optional block is gated on its driving field's truthiness, exactly
    like the source's `${var:+...}` bash expansions -- both the heading AND
    the blank-line spacing around it. That spacing is NOT uniform: sections
    are built from two different source shapes (see contract `01` §4), so a
    naive `"\\n\\n".join(present_parts)` under-counts blank lines whenever a
    block is *omitted*, and this function does not do that.

    HISTORICAL NOTE, kept for anyone who hits a corrupted thread block in an
    old log: until 2026-08-17, `auto-run.sh` (running under bash 3.2.57 --
    the only bash on this machine, and in production, since
    `#!/usr/bin/env bash` resolves to whatever's on PATH) had a real bug here.
    Its `${thread_context:+word}` parser did not track nested bare `{`/`}` --
    it ended the substitution at the FIRST unquoted `}`, which was the one
    closing the JSON example inside `word` itself (`{"action":"comment",...}`),
    not the real terminator after `$thread_context`. Concretely: the
    "## 正在进行的讨论" heading and its first two instructional lines were
    silently swallowed whenever `thread_context` was empty, but a stray tail --
    "。\\n不感兴趣就跳过——不必为了用上这块内容而硬接话。\\n\\n}" -- leaked into
    EVERY prompt unconditionally, and when `thread_context` WAS populated, the
    quotes inside that one JSON example got stripped, turning it into
    invalid-looking JSON (`{action:comment,...}`), with a bare `}` glued onto
    the end of the real thread content. This function always rendered the
    text as written in `auto-run.sh`'s source (and as contract `01` §4 quotes
    it), never bash 3.2's mis-parse of it -- reproducing the bug would have
    corrupted the one piece of text that teaches the model how `parentId`
    maps to a thread comment's `[24位ID]`, exactly backwards from why this
    prompt is copied verbatim in the first place.

    Fixed in `auto-run.sh` by commit `97b3021` (holds the JSON example behind
    a nested `${comment_reply_example}` reference, the one brace form bash
    3.2's scanner does track correctly, instead of inlining literal braces
    into the `${thread_context:+...}` word). Python and Bash now agree
    byte-for-byte on this section -- independently verified by rendering both
    the pre-fix and post-fix heredoc under real bash 3.2.57 across 9
    scenarios and diffing against this function's actual output: pre-fix, the
    only diff in either direction was exactly the artifact above; post-fix,
    zero diff. There is no longer a predicted divergence here for a future
    reader to explain away -- if this section disagrees with Bash again, that
    is a new, real divergence, not this one recurring.
    """
    text = "## 当前上下文\n" + ctx.context_now + "\n"
    if ctx.feed_context:
        text += f"\n{_FEED_HEADING}\n{ctx.feed_context}"
    text += f"\n\n{_NOTIFICATION_HEADING}\n{ctx.notification_context}"

    text += f"\n\n{_MEMORY_HEADING}\n{ctx.recent_memory}\n"
    if ctx.engaged_ids:
        text += f"\n{_ENGAGED_HEADING}\n{ctx.engaged_ids}\n{_ENGAGED_WARNING}"

    text += (
        f"\n\n{_STATS_HEADING}\n"
        f"- 今天（{ctx.today}）已发帖次数：{ctx.today_post_count}\n"
        f"- 最近一条发帖记录：{ctx.last_post}"
    )
    text += f"\n\n{_RHYTHM_HEADING}\n{rhythm_guidance}"

    text += f"\n\n{_GLOBAL_FEED_HEADING}\n{ctx.global_feed}\n"
    if ctx.timeline_feed:
        text += f"\n{_TIMELINE_HEADING}\n{ctx.timeline_feed}"
    text += "\n"
    if ctx.thread_context:
        text += f"\n{_THREAD_SECTION_HEADER}\n\n{ctx.thread_context}"
    text += "\n"
    if ctx.contacts_list:
        text += f"\n{_CONTACTS_HEADING}\n{ctx.contacts_list}"
    text += "\n"
    if ctx.dm_context:
        text += f"\n{_DM_HEADING}\n{ctx.dm_context}"

    text += "\n\n" + _TAIL_HEAD
    text += ctx.backend_action_constraint
    text += "\n\n" + _TAIL_BUDGET_PREFIX + str(ctx.action_budget) + _TAIL_BODY
    return text


def plan_round(
    backend: Backend,
    persona: Persona,
    ctx: ActContext,
    *,
    rhythm_guidance: str,
) -> Plan | None:
    """Ask the backend for a plan; `personality.md` is the system prompt.

    Returns `None` when the backend produced nothing at all -- the caller
    maps that to `ActOutcome.BACKEND_UNAVAILABLE`. A `Plan` with no actions
    (the model deliberately chose `nothing`) is a DIFFERENT outcome, and
    keeping them apart is the whole point of design spec §7.1: Bash returns
    rc=75 for both, which is why a deliberately quiet round used to cost the
    account its dream.

    `Backend.complete` (see `llm/base.py`) signals "nothing" by raising
    `BackendUnavailableError`, not by returning an empty string -- every
    concrete backend (claude/codex/deepseek) does this, so that is the
    silence signal this function must actually watch for; `complete_json`
    does not catch it, so this function does.

    No retry here. Bash makes exactly one attempt (contract `01` §4:
    `ask_llm_json` -> `llm_json` -> `_llm_raw` is a single shot, no timeout,
    no re-ask). Retry belongs to the graph layer's RetryPolicy (Plan 3), not
    to this function -- adding it here would multiply against that.
    """
    request = CompletionRequest(
        system=persona.raw,
        user=render_planner_prompt(ctx, rhythm_guidance=rhythm_guidance),
        model=persona.model,
    )
    try:
        raw = complete_json(backend, request)
    except BackendUnavailableError:
        return None
    if not raw:
        return None
    return normalize_plan(raw)
