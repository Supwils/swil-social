"""Golden test: the Python rhythm parser must agree with the live Bash parser on
every real account, at four post counts. Ground truth is captured by
`capture_rhythm.sh` — regenerate it if any personality.md rhythm section changes.
"""

import csv
import random
from pathlib import Path

import pytest

from swil_agent.models import RhythmPolicy
from swil_agent.persona.loader import load_persona, resolve_agent_dir
from swil_agent.persona.rhythm import decide_rhythm

AGENT_ROOT = Path(__file__).resolve().parents[2]
GROUND_TRUTH = Path(__file__).parent / "rhythm_ground_truth.tsv"


class FixedRoll(random.Random):
    """Bash `RANDOM=42` produces a first draw of 82. Reproduce that draw only."""

    def randint(self, a: int, b: int) -> int:
        return 82


def _rows() -> list[dict[str, str]]:
    with GROUND_TRUTH.open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh, delimiter="\t"))


def test_ground_truth_covers_every_account_at_four_post_counts() -> None:
    rows = _rows()
    assert len(rows) == 92, f"expected 23 accounts x 4 post counts, got {len(rows)}"
    assert len({r["account"] for r in rows}) == 23


@pytest.mark.parametrize("row", _rows(), ids=lambda r: f"{r['account']}-{r['posts_today']}")
def test_matches_bash_parser(row: dict[str, str]) -> None:
    persona = load_persona(resolve_agent_dir(AGENT_ROOT, row["account"]))
    got = decide_rhythm(persona.rhythm_text, int(row["posts_today"]), FixedRoll())
    assert got.policy.value == row["policy"]
    assert got.prefer_non_post == row["prefer_non_post"]


def test_priority_list_without_literal_pairs_falls_through_to_nothing() -> None:
    """Pins the liushang/yingying behavior: `post > like > comment > follow >
    nothing` contains neither `comment > like` nor `like > nothing`, so rule 1
    reaches the bare `nothing` branch. Preserved deliberately (spec 12.1)."""
    text = "- 动作优先级：post > like > comment > follow > nothing\n"
    assert decide_rhythm(text, 0, FixedRoll()).prefer_non_post == "nothing"


def test_comment_before_like_yields_comment() -> None:
    text = "- 动作优先级：comment > like > nothing\n"
    assert decide_rhythm(text, 0, FixedRoll()).prefer_non_post == "comment"


def test_default_prefer_non_post_is_like_when_no_priority_line() -> None:
    assert decide_rhythm("- 无优先级说明\n", 0, FixedRoll()).prefer_non_post == "like"


def test_ceiling_takes_precedence_over_probability() -> None:
    text = "- 每次触发有 90% 概率选择 post\n- 若今天已有 1 条发帖记录，则倾向沉默\n"
    d = decide_rhythm(text, 1, FixedRoll())
    assert d.policy is RhythmPolicy.NO_POST
    assert d.post_ceiling == 1
    assert d.roll is None, "the ceiling branch returns before rolling"


def test_probability_hit_yields_must_post() -> None:
    text = "- 每次触发有 90% 概率选择 post\n"
    d = decide_rhythm(text, 0, FixedRoll())
    assert d.policy is RhythmPolicy.MUST_POST
    assert d.post_probability == 90
    assert d.roll == 82


def test_probability_miss_yields_no_post() -> None:
    text = "- 每次触发有 50% 概率选择 post\n"
    d = decide_rhythm(text, 0, FixedRoll())
    assert d.policy is RhythmPolicy.NO_POST
    assert d.roll == 82


def test_must_post_phrase_without_probability() -> None:
    for phrase in ("- 本账号必须发帖\n", "- 首选 post\n"):
        assert decide_rhythm(phrase, 0, FixedRoll()).policy is RhythmPolicy.MUST_POST


def test_unparseable_section_falls_back_to_free() -> None:
    """No real account currently reaches this branch, so it needs a synthetic
    fixture. Falling back to `free` is what CLAUDE.md warns about."""
    d = decide_rhythm("- 随心而行，没有明确规则\n", 0, FixedRoll())
    assert d.policy is RhythmPolicy.FREE
    assert "未解析到明确概率" in d.guidance


def test_ceiling_three_variants() -> None:
    assert decide_rhythm("已有 3 条以上发帖记录\n", 3, FixedRoll()).post_ceiling == 3
    assert decide_rhythm("已有 2 条发帖记录\n", 2, FixedRoll()).post_ceiling == 2
    assert decide_rhythm("已有一条发帖记录\n", 1, FixedRoll()).post_ceiling == 1
    assert decide_rhythm("已有发帖记录\n", 1, FixedRoll()).post_ceiling == 1


def test_suffixed_rhythm_heading_still_parses_to_a_real_policy_not_free(tmp_path: Path) -> None:
    """A dream may rename the heading with an appended suffix (e.g. a
    parenthetical annotation tacked onto "发帖节律") -- both Bash consumers
    (`build_rhythm_guidance`'s awk, dream.sh's grep) match it by prefix and
    accept it. If `get_section` regressed to exact
    matching, `load_persona` would silently hand `decide_rhythm` an empty
    `rhythm_text`, which parses to `RhythmPolicy.FREE` -- the state
    CLAUDE.md explicitly says to avoid, with nothing logging the loss. Route
    this through the real `load_persona` (not a hand-built rhythm_text
    string) so the whole path -- file -> get_section -> decide_rhythm -- is
    exercised, not just the parser in isolation."""
    directory = tmp_path / "suffixed_heading_account"
    directory.mkdir()
    (directory / "personality.md").write_text(
        "# Synthetic\n\n"
        "## 身份\n"
        "- **Username:** suffix_tester\n"
        "- **Display Name:** Suffix Tester\n"
        "- **Headline:** a test fixture\n"
        "- **Bio:** exists to exercise a renamed rhythm heading.\n"
        "- **Follow Topics:** testing,fixtures\n\n"
        "## 发帖节律（本轮微调）\n"
        "- 每次触发有 90% 概率选择 post\n",
        encoding="utf-8",
    )
    persona = load_persona(directory)
    assert persona.rhythm_text == "- 每次触发有 90% 概率选择 post"
    d = decide_rhythm(persona.rhythm_text, 0, FixedRoll())
    assert d.policy is not RhythmPolicy.FREE
    assert d.policy is RhythmPolicy.MUST_POST
    assert d.post_probability == 90
