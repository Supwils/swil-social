"""Parse the `## 发帖节律` prose section into a rhythm decision.

A faithful port of `agent/scripts/auto-run.sh::build_rhythm_guidance`. The
section is natural-language Chinese that the dream step rewrites, so the parser
is a set of ordered regexes over prose. Several outcomes look unintended (see
`prefer_non_post` below); they are current behavior and are pinned by
`tests/golden/rhythm_ground_truth.tsv`. Changing them is out of scope — the
whole file is embedded for drift measurement, so altering the format shifts
every account's drift score.
"""

from __future__ import annotations

import random
import re

from swil_agent.models import RhythmDecision, RhythmPolicy

# Ordered: first match wins. Note that a priority list like
# `post > like > comment > follow > nothing` matches NEITHER of the first two
# patterns (the literal pairs do not occur) and therefore falls through to the
# bare `nothing` branch. liushang and yingying land here.
_PREFER_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"动作优先级：.*comment > like", "comment"),
    (r"动作优先级：.*like > nothing", "like"),
    (r"动作优先级：.*nothing", "nothing"),
)
_PREFER_DEFAULT = "like"

_CEILING_PATTERNS: tuple[tuple[str, int], ...] = (
    (r"已有\s*3\s*条以上发帖记录|已有\s*3\s*条以上", 3),
    (r"已有\s*2\s*条以上发帖记录|已有\s*2\s*条发帖记录|已有\s*2\s*条以上", 2),
    (r"已有一条发帖记录|已有\s*1\s*条发帖记录|已有发帖记录", 1),
)

_PROBABILITY = re.compile(r"(\d+)% 概率选择 post")
_MUST_POST = re.compile(r"必须发帖|首选 post")


def _prefer_non_post(one_line: str) -> str:
    for pattern, value in _PREFER_PATTERNS:
        if re.search(pattern, one_line):
            return value
    return _PREFER_DEFAULT


def _post_ceiling(text: str) -> int | None:
    for pattern, value in _CEILING_PATTERNS:
        if re.search(pattern, text):
            return value
    return None


def decide_rhythm(rhythm_text: str, posts_today: int, rng: random.Random) -> RhythmDecision:
    one_line = rhythm_text.replace("\n", " ")
    prefer = _prefer_non_post(one_line)
    ceiling = _post_ceiling(rhythm_text)

    if ceiling is not None and posts_today >= ceiling:
        return RhythmDecision(
            policy=RhythmPolicy.NO_POST,
            prefer_non_post=prefer,
            post_ceiling=ceiling,
            guidance=(
                f"- 本轮动作约束：今天已发 {posts_today} 条，已达到该账号的发帖上限；"
                "本轮禁止选择 post。\n"
                f"- 本轮非发帖优先级：优先 {prefer}，其次再考虑其他非发帖动作。"
            ),
        )

    prob_match = _PROBABILITY.search(rhythm_text)
    if prob_match is not None:
        prob = int(prob_match.group(1))
        roll = rng.randint(1, 100)
        if roll <= prob:
            return RhythmDecision(
                policy=RhythmPolicy.MUST_POST,
                prefer_non_post=prefer,
                post_ceiling=ceiling,
                post_probability=prob,
                roll=roll,
                guidance=(
                    f"- 本轮随机抽样：{roll}/100，命中 {prob}% 的 post 概率；本轮必须选择 post。"
                ),
            )
        return RhythmDecision(
            policy=RhythmPolicy.NO_POST,
            prefer_non_post=prefer,
            post_ceiling=ceiling,
            post_probability=prob,
            roll=roll,
            guidance=(
                f"- 本轮随机抽样：{roll}/100，未命中 {prob}% 的 post 概率；本轮禁止选择 post。\n"
                f"- 本轮非发帖优先级：优先 {prefer}，其次再考虑其他非发帖动作。"
            ),
        )

    if _MUST_POST.search(rhythm_text):
        return RhythmDecision(
            policy=RhythmPolicy.MUST_POST,
            prefer_non_post=prefer,
            post_ceiling=ceiling,
            guidance="- 本轮动作约束：根据该账号的发帖节律，本轮必须优先选择 post。",
        )

    return RhythmDecision(
        policy=RhythmPolicy.FREE,
        prefer_non_post=prefer,
        post_ceiling=ceiling,
        guidance="- 本轮动作约束：未解析到明确概率；请严格按发帖节律与行为规则自行保守决策。",
    )
