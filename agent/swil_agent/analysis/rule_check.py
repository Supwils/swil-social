"""Does an account obey the machine-checkable rules it wrote for itself?

Port of `agent/scripts/rule-check.sh` (frozen; that script, not any prose about
it, is the contract). Two rules are parseable deterministically -- a hashtag
count band and a no-exclamation vow -- and each yields one `rule_check` lab
event carrying the adherence rate over the account's recent posts. Free-form
`行为规则` prose is deliberately out of scope, left for a future LLM judge.

The module is split in two on purpose:

  * `check_rules(personality_text, posts)` is PURE. Every recorded defect in
    `rule-check.sh` lived in the rule parsing, including one that reached
    production (see `MAX_HASHTAGS`), so that class has to be reachable from a
    test with no HTTP transport, no fixture account on disk and no daemon.
  * `run_rule_check(...)` is the only part that touches the world: it reads
    the account's files, fetches its posts and POSTs the events.

Fail-soft is a hard requirement, not a quality bar (plan ruling R3): no
`api_key.txt`, no posts, no parseable rules and a dead network all return
cleanly without emitting. Bash swallows this script's exit code with `|| true`
at every call site, so a measurement outage must never be visible as a round
failure.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Final

from pydantic import BaseModel, ConfigDict, Field

from swil_agent.api.client import ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.api.resources import Resources

logger = logging.getLogger(__name__)

# `LIMIT="${RULE_CHECK_POST_LIMIT:-12}"` (rule-check.sh:25). The env var has no
# `Settings` field yet because nothing in the Python runtime reads it; callers
# that want to honour it pass `limit=` explicitly rather than this module
# reaching into `os.environ` behind the caller's back.
DEFAULT_POST_LIMIT: Final = 12

# MAX_HASHTAGS bounds what counts as a plausible explicit range. Without it the
# range pattern also matches *dates*: a dated memory line such as
#   "- 2026-06-24 | ...标签越顺手，越要检查它压掉了什么。"
# contains 标签, so `2026-06` parsed as min=2026 max=6 -- a range no post can
# satisfy. That reported `quant` as 0% adherent to a hashtag rule it never
# wrote, and shipped it to /lab as a `flagged` rule_check event.
# (rule-check.sh:84-89, verbatim.)
MAX_HASHTAGS: Final = 20

# A max at or above this reads as "no upper bound" and is dropped from the
# summary text -- `hi = "" if hashtag_max >= 99 else ...` (rule-check.sh:116).
# It is also the max the two open-ended fallbacks synthesise.
UNBOUNDED_MAX: Final = 99

# `"success" if rate >= 0.8 else "flagged"` (rule-check.sh:74). Inclusive: a
# rate of exactly 0.8 is a success.
SUCCESS_RATE: Final = 0.8

_RANGE_RE: Final = re.compile(r"(\d+)\s*[～~\-－]\s*(\d+)")
_AT_LEAST_RE: Final = re.compile(r"至少\s*(\d+)")
_SPARSE_RE: Final = re.compile(r"不用\s*hashtag|不用标签|偶尔用一个|不带\s*hashtag")
_MANDATORY_RE: Final = re.compile(r"每帖必带|必须用\s*hashtag")
_TAG_RE: Final = re.compile(r"[#＃][0-9A-Za-z_一-鿿]+")
_NO_EXCLAMATION_RE: Final = re.compile(r"(不用|不喜欢|绝不用|永远不用|不使用)[^。\n]{0,8}感叹号")

PERSONALITY_FILENAME: Final = "personality.md"
API_KEY_FILENAME: Final = "api_key.txt"


class RuleEvent(BaseModel):
    """One rule's adherence measurement over one sample of posts.

    Domain-shaped and snake_case, per `models.py`'s convention; `to_lab_event`
    is the single place it becomes wire-shaped.

    `checked` is constrained `> 0` rather than merely guarded by the caller.
    `rate` divides by it, and the "don't emit a measurement of nothing" rule
    (`if checked == 0: return`, rule-check.sh:67-68) is the kind of guard that
    protects only its own call site if it lives one level up -- an account with
    a no-exclamation vow and zero recent posts hits exactly that path every
    round. Putting the invariant on the model means a second construction site
    cannot silently reintroduce a `0/0` event or a ZeroDivisionError.
    """

    model_config = ConfigDict(frozen=True)

    rule: str
    passes: int
    checked: int = Field(gt=0)
    detail: str

    @property
    def rate(self) -> float:
        """`rate = round(passes / checked, 4)` (rule-check.sh:69)."""
        return round(self.passes / self.checked, 4)

    @property
    def outcome(self) -> str:
        return "success" if self.rate >= SUCCESS_RATE else "flagged"

    @property
    def summary(self) -> str:
        """`f"{detail}: {passes}/{checked} posts adherent ({pct}%)"`.

        `pct` is rounded from the ALREADY-rounded `rate`, not from the raw
        quotient (rule-check.sh:69-70) -- so it inherits both that rounding and
        Python's banker's-rounding tie rule, which is what the /lab summaries
        have been showing all along.
        """
        pct = round(self.rate * 100)
        return f"{self.detail}: {self.passes}/{self.checked} posts adherent ({pct}%)"

    def to_lab_event(self) -> LabEvent:
        return LabEvent(
            type="rule_check",
            phase="rule",
            outcome=self.outcome,
            summary=self.summary,
            metrics={"rule": self.rule, "passRate": self.rate, "checked": self.checked},
        )


def _fallback_bounds(line: str) -> tuple[int, int] | None:
    """The looser statements, in the script's own precedence order.

    Note the case handling, which is NOT uniform and is reproduced as-is:
    `至少`, the four "sparse" alternatives and the range pattern are matched
    against the RAW line, while `每帖必带|必须用 hashtag` and the literal
    `必带 hashtag` are matched against the LOWERCASED line (rule-check.sh:103,
    106, 108). So `不用 HASHTAG` does not match but `必带 HASHTAG` does.
    """
    at_least = _AT_LEAST_RE.search(line)
    if at_least:
        return int(at_least.group(1)), UNBOUNDED_MAX
    if _SPARSE_RE.search(line):
        return 0, 1
    low = line.lower()
    if _MANDATORY_RE.search(low) or "必带 hashtag" in low:
        return 1, UNBOUNDED_MAX
    return None


def parse_hashtag_bounds(personality_text: str) -> tuple[int, int] | None:
    """The `(min, max)` hashtag band the account stated, or None.

    An explicit range anywhere wins outright; otherwise the FIRST looser
    statement found while scanning does. A line is a candidate only if it
    contains `hashtag` case-insensitively or the literal `标签`.

    An implausible range is DISCARDED AND SCANNING CONTINUES (the same line is
    still offered to the fallbacks, and later lines are still read), so a real
    rule further down the file is still found. That is the whole defence
    described at `MAX_HASHTAGS` above: the memory section of a real
    `personality.md` is full of dated lines, and any one of them mentioning
    标签 would otherwise shadow the actual rule.
    """
    fallback: tuple[int, int] | None = None
    for line in personality_text.splitlines():
        low = line.lower()
        if "hashtag" not in low and "标签" not in line:
            continue
        found = _RANGE_RE.search(line)
        if found is not None:
            low_bound, high_bound = int(found.group(1)), int(found.group(2))
            if 0 <= low_bound <= high_bound <= MAX_HASHTAGS:
                return low_bound, high_bound
        if fallback is None:
            fallback = _fallback_bounds(line)
    return fallback


def count_tags(post: str) -> int:
    """`len(tag_re.findall(p))` for `[#＃][0-9A-Za-z_一-鿿]+` (rule-check.sh:114).

    Both the ASCII `#` and the full-width `＃` open a tag -- agents write both,
    and dropping the full-width form under-counts a CJK account's tags, which
    reads as "obeys a 0-1 rule" rather than as a parser gap.
    """
    return len(_TAG_RE.findall(post))


def states_no_exclamation_rule(personality_text: str) -> bool:
    """Whole-document match, not per-line (rule-check.sh:120)."""
    return _NO_EXCLAMATION_RE.search(personality_text) is not None


def check_rules(personality_text: str, posts: list[str]) -> list[RuleEvent]:
    """Score `posts` against the rules stated in `personality_text`. Pure.

    Returns one event per rule the document actually states and the sample can
    actually measure -- so `[]` means "nothing to say", never "0% adherent".
    """
    events: list[RuleEvent] = []
    total = len(posts)

    bounds = parse_hashtag_bounds(personality_text)
    if bounds is not None and total:
        low_bound, high_bound = bounds
        passes = sum(1 for post in posts if low_bound <= count_tags(post) <= high_bound)
        suffix = "" if high_bound >= UNBOUNDED_MAX else f"-{high_bound}"
        events.append(
            RuleEvent(
                rule="hashtag_count",
                passes=passes,
                checked=total,
                detail=f"hashtag count {low_bound}{suffix}",
            )
        )

    if states_no_exclamation_rule(personality_text) and total:
        passes = sum(1 for post in posts if "!" not in post and "！" not in post)
        events.append(
            RuleEvent(
                rule="no_exclamation",
                passes=passes,
                checked=total,
                detail="no exclamation mark",
            )
        )

    return events


def extract_posts(items: Iterable[dict[str, Any]]) -> list[str]:
    """`originalText` first, then `text`; blank-only entries dropped.

    `originalText` is the pre-render body an agent actually wrote, so it is the
    text its own rules were about (rule-check.sh:58-61).
    """
    posts: list[str] = []
    for item in items:
        raw: Any = item.get("originalText") or item.get("text") or ""
        if isinstance(raw, str) and raw.strip():
            posts.append(raw)
    return posts


def run_rule_check(
    resources: Resources,
    *,
    directory: Path,
    username: str,
    limit: int = DEFAULT_POST_LIMIT,
) -> list[RuleEvent]:
    """Fetch, score and emit. Returns the events emitted (`[]` if none were).

    `personality.md` is re-read HERE rather than taken from an already-loaded
    `Persona`, because that is what makes the call ORDER load-bearing the way
    Bash's is: `cycle-one.sh:39-41` runs this before the dream precisely
    because the dream rewrites that file, and sampling afterwards measures the
    new rules against the old posts. A caller handing in text captured at the
    start of the round would make an ordering defect undetectable rather than
    impossible (plan ruling R1).

    The `api_key.txt` gate is the script's own skip (rule-check.sh:38) and is
    checked against the account directory, not against `resources`: `Resources`
    carries whatever `resolve_auth` picked, which for a key-less account is the
    session-cookie fallback -- credentials that reach the read endpoint but
    leave the lab event unwritten. Skipping the whole account, as Bash does,
    beats emitting a measurement nobody can store.
    """
    name = directory.name
    if not (directory / API_KEY_FILENAME).is_file():
        logger.info("rule-check: no api_key.txt for %s — skipping", name)
        return []

    personality_text = (directory / PERSONALITY_FILENAME).read_text(encoding="utf-8")

    try:
        items = resources.user_posts(username, limit=limit)
    except ApiError:
        # `curl ... || echo ''` (rule-check.sh:41-43): an unreachable platform
        # degrades to an empty sample, which yields no events, not a flagged
        # one. Reporting 0% adherence because the network was down is exactly
        # the failure this whole module is careful about.
        logger.info("rule-check: %s — could not fetch posts; nothing to check", name)
        return []

    events = check_rules(personality_text, extract_posts(items))
    if not events:
        logger.info("rule-check: %s — no parseable rules or no posts; nothing to check", name)
        return []

    for event in events:
        resources.lab_event(username, event.to_lab_event())
        logger.info("rule-check: %s", event.summary)
    return events
