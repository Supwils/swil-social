"""Rule-adherence parsing, ported from `agent/scripts/rule-check.sh` (frozen).

The first two tests encode a defect that reached production; they were written
before the implementation on purpose.

Everything asserted here was additionally checked against the script's OWN
embedded Python: lines 47-124 were extracted verbatim and run side by side with
`check_rules` over 49 hand-built cases plus all 69 real `personality.md` /
`personality.archive.md` / `memory.md` documents in the repo (34 events), with
zero mismatches. Where the task brief and the script disagreed, the script won
-- see `test_the_sparse_fallback_is_case_sensitive_but_the_mandatory_one_is_not`.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError

from swil_agent.analysis.rule_check import (
    DEFAULT_POST_LIMIT,
    MAX_HASHTAGS,
    RuleEvent,
    check_rules,
    count_tags,
    extract_posts,
    parse_hashtag_bounds,
    run_rule_check,
    states_no_exclamation_rule,
)
from swil_agent.api.auth import ApiKeyAuth
from swil_agent.api.client import ApiClient
from swil_agent.api.resources import Resources

# ── the incident ─────────────────────────────────────────────────────────


def test_a_dated_line_containing_标签_is_not_read_as_a_hashtag_range() -> None:
    """Regression, documented inline in rule-check.sh. `2026-06` must not parse
    as min=2026 max=6 -- that reported quant as 0% adherent to a rule it never
    wrote and shipped a `flagged` event to /lab."""
    text = "- 2026-06-24 | 标签越顺手，越要检查它压掉了什么。\n"
    assert check_rules(text, ["#a #b post"]) == []


def test_an_implausible_range_does_not_stop_the_scan() -> None:
    """The script discards a bad range and keeps scanning, so a real rule
    further down the file is still found."""
    text = "- 2026-06-24 | 标签…\n- hashtag 2～4 个\n"
    events = check_rules(text, ["#a #b #c x"])
    assert [e.rule for e in events] == ["hashtag_count"]


def test_an_implausible_range_still_offers_its_own_line_to_the_fallbacks() -> None:
    """Discarding the range does not discard the LINE: control flow falls
    through to the fallback block on the same iteration (rule-check.sh:99-109),
    so `至少 3` on a dated line is still read."""
    text = "- 2026-06-24 | 标签至少 3 个\n"
    assert parse_hashtag_bounds(text) == (3, 99)


def test_the_max_hashtags_bound_is_twenty() -> None:
    """Pinned as a value, not only through its effect: it is the entire defence
    against the dated-line class, and 20 is what the frozen script says."""
    assert MAX_HASHTAGS == 20


# ── explicit range ───────────────────────────────────────────────────────


@pytest.mark.parametrize("separator", ["～", "~", "-", "－"])
def test_every_range_separator_the_script_accepts(separator: str) -> None:
    assert parse_hashtag_bounds(f"hashtag 1{separator}3 个") == (1, 3)


def test_whitespace_is_allowed_around_the_range_separator() -> None:
    assert parse_hashtag_bounds("hashtag 2 ～ 4 个") == (2, 4)


def test_a_range_at_the_bound_is_accepted() -> None:
    assert parse_hashtag_bounds("hashtag 0-20") == (0, 20)


def test_a_range_one_over_the_bound_is_rejected() -> None:
    assert parse_hashtag_bounds("hashtag 0-21") is None


def test_an_inverted_range_is_rejected() -> None:
    """`min <= max` is part of the plausibility test, not an accident of it."""
    assert parse_hashtag_bounds("hashtag 5-2") is None


def test_an_explicit_range_beats_a_fallback_stated_earlier_in_the_file() -> None:
    """The range wins wherever it sits: the loop returns on the first sane one,
    while a fallback is only consulted after the whole scan (rule-check.sh:110)."""
    assert parse_hashtag_bounds("至少 5 个标签\nhashtag 1～2\n") == (1, 2)


def test_an_explicit_range_beats_a_fallback_stated_later_in_the_file() -> None:
    assert parse_hashtag_bounds("hashtag 1～2\n至少 5 个标签\n") == (1, 2)


# ── which lines are candidates at all ────────────────────────────────────


def test_a_line_mentioning_neither_hashtag_nor_标签_is_skipped() -> None:
    """A range on an unrelated line must not become the rule."""
    assert parse_hashtag_bounds("每天写 2-4 条帖子\n") is None


def test_hashtag_is_matched_case_insensitively_as_a_candidate() -> None:
    assert parse_hashtag_bounds("HASHTAG 1～2") == (1, 2)


# ── fallbacks ────────────────────────────────────────────────────────────


def test_at_least_n_becomes_an_open_ended_band() -> None:
    assert parse_hashtag_bounds("标签至少 2 个") == (2, 99)


def test_at_least_tolerates_whitespace_before_the_number() -> None:
    assert parse_hashtag_bounds("hashtag 至少   3") == (3, 99)


@pytest.mark.parametrize(
    "line",
    ["我不用 hashtag", "不用hashtag", "不用标签", "标签偶尔用一个", "不带 hashtag"],
)
def test_the_sparse_alternatives_become_zero_to_one(line: str) -> None:
    assert parse_hashtag_bounds(line) == (0, 1)


@pytest.mark.parametrize(
    "line", ["每帖必带标签", "必须用 hashtag", "必须用hashtag", "必带 hashtag"]
)
def test_the_mandatory_alternatives_become_one_to_open_ended(line: str) -> None:
    assert parse_hashtag_bounds(line) == (1, 99)


def test_the_sparse_fallback_is_case_sensitive_but_the_mandatory_one_is_not() -> None:
    """SCRIPT BEATS BRIEF. The brief lists both fallback groups flatly, but
    rule-check.sh matches `至少` and the four sparse alternatives against the
    RAW line (:103, :106) and the mandatory ones against the LOWERCASED line
    (:108). So an account that writes `不用 HASHTAG` states no parseable rule,
    while `必带 HASHTAG` states one. Reproduced, not tidied: normalising either
    way would change which of 23 live accounts gets measured."""
    assert parse_hashtag_bounds("不用 HASHTAG") is None
    # Both mandatory arms read the lowercased line -- the regex one and the
    # `"必带 hashtag" in low` literal -- so both are pinned uppercase here.
    assert parse_hashtag_bounds("必带 HASHTAG") == (1, 99)
    assert parse_hashtag_bounds("必须用 HASHTAG") == (1, 99)


def test_the_first_fallback_found_wins_and_later_ones_are_ignored() -> None:
    """`if fallback is None` (rule-check.sh:102) is what makes this first-wins
    rather than last-wins."""
    assert parse_hashtag_bounds("标签至少 2 个\n不用标签\n") == (2, 99)


def test_the_fallback_precedence_within_one_line_is_at_least_then_sparse() -> None:
    """Both patterns match this line; `至少` is tested first (rule-check.sh:103)."""
    assert parse_hashtag_bounds("不用标签，至少 2 个") == (2, 99)


def test_a_candidate_line_stating_no_rule_at_all_yields_nothing() -> None:
    assert parse_hashtag_bounds("我对 hashtag 没有意见\n") is None


# ── tag counting ─────────────────────────────────────────────────────────


def test_a_full_width_hash_opens_a_tag() -> None:
    """Agents write ＃ as readily as #. Dropping it under-counts a CJK
    account's tags, which reads on /lab as obedience to a 0-1 rule rather
    than as a parser gap."""
    assert count_tags("＃全角 正文") == 1
    assert count_tags("＃一 #two ＃三") == 3


def test_a_tag_body_may_be_cjk_ascii_digits_or_underscore() -> None:
    assert count_tags("#中文标签 #a_b1") == 2
    # `#a_b1` alone cannot show that `_` is in the class -- it still matches as
    # `#a` if the underscore is dropped. A LEADING underscore is what makes the
    # character discriminable: without it in the class there is no tag at all.
    assert count_tags("#_private") == 1


def test_a_hash_with_no_body_is_not_a_tag() -> None:
    assert count_tags("# a") == 0


def test_punctuation_terminates_a_tag_body() -> None:
    assert count_tags("#a,#b") == 2
    assert count_tags("#a-b") == 1


# ── no-exclamation rule ──────────────────────────────────────────────────


@pytest.mark.parametrize("verb", ["不用", "不喜欢", "绝不用", "永远不用", "不使用"])
def test_every_no_exclamation_verb_the_script_accepts(verb: str) -> None:
    assert states_no_exclamation_rule(f"我{verb}感叹号")


def test_up_to_eight_characters_may_sit_between_the_verb_and_感叹号() -> None:
    assert states_no_exclamation_rule("不用" + "x" * 8 + "感叹号")
    assert not states_no_exclamation_rule("不用" + "x" * 9 + "感叹号")


def test_a_full_stop_between_the_verb_and_感叹号_blocks_the_match() -> None:
    """`[^。\\n]` — the gap may not cross a sentence or a line boundary."""
    assert not states_no_exclamation_rule("不用。感叹号")
    assert not states_no_exclamation_rule("不用\n感叹号")


def test_the_no_exclamation_rule_is_matched_over_the_whole_document() -> None:
    """Unlike the hashtag scan this is one search over `text`, so the verb and
    `感叹号` may not be split across lines but need not be on the first."""
    assert states_no_exclamation_rule("## 风格\n随便写点什么\n我不使用感叹号\n")


def test_both_exclamation_marks_fail_a_post() -> None:
    events = check_rules("我不用感叹号", ["ok", "half!", "全角！"])
    assert [(e.rule, e.passes, e.checked) for e in events] == [("no_exclamation", 1, 3)]


# ── event shape ──────────────────────────────────────────────────────────


def test_a_rate_of_exactly_zero_point_eight_is_a_success() -> None:
    """`rate >= 0.8` (rule-check.sh:74) — the boundary is inclusive. 4/5."""
    events = check_rules("hashtag 1-1", ["#a", "#a", "#a", "#a", "no tag"])
    assert events[0].rate == 0.8
    assert events[0].outcome == "success"


def test_a_rate_just_under_zero_point_eight_is_flagged() -> None:
    events = check_rules("hashtag 1-1", ["#a", "#a", "#a", "no tag"])
    assert events[0].rate == 0.75
    assert events[0].outcome == "flagged"


def test_the_rate_is_rounded_to_four_places() -> None:
    events = check_rules("hashtag 1-1", ["#a", "#a", "no tag"])
    assert events[0].rate == 0.6667


def test_the_summary_percentage_is_rounded_from_the_already_rounded_rate() -> None:
    events = check_rules("hashtag 1-1", ["#a", "#a", "no tag"])
    assert events[0].summary == "hashtag count 1-1: 2/3 posts adherent (67%)"


def test_the_percentage_comes_from_the_rounded_rate_not_the_raw_quotient() -> None:
    """The two formulas agree for every sample smaller than 103, so this is the
    smallest case that can tell them apart: `round(0.165 * 100)` banker's-rounds
    DOWN to 16, while `round(17 / 103 * 100)` is 17. rule-check.sh:69-70 rounds
    the rate first, so 16 is what /lab has been showing all along -- and the
    sample size is a caller-supplied `limit`, not a constant, so this is
    reachable rather than hypothetical."""
    event = RuleEvent(rule="hashtag_count", passes=17, checked=103, detail="hashtag count 1-1")
    assert event.rate == 0.165
    assert event.summary == "hashtag count 1-1: 17/103 posts adherent (16%)"


def test_an_open_ended_maximum_is_dropped_from_the_summary() -> None:
    """`hi = "" if hashtag_max >= 99` — "hashtag count 2", not "2-99"."""
    events = check_rules("标签至少 2 个", ["#a #b"])
    assert events[0].detail == "hashtag count 2"
    assert events[0].summary == "hashtag count 2: 1/1 posts adherent (100%)"


def test_a_bounded_maximum_is_shown_in_the_summary() -> None:
    events = check_rules("hashtag 2-4", ["#a #b"])
    assert events[0].detail == "hashtag count 2-4"


def test_only_a_synthesised_maximum_can_ever_reach_the_open_ended_threshold() -> None:
    """Worth stating because it is not obvious from `hi = "" if hashtag_max >= 99`
    read alone: an EXPLICIT `1-99` is 99 > MAX_HASHTAGS, so it never survives
    the plausibility gate and never reaches the summary at all. The only values
    `hashtag_max` can hold are 0..20 (explicit), 1 (sparse) or 99 (the two
    open-ended fallbacks) -- so `>= 99` and `== 99` are equivalent TODAY, and
    stop being so the moment MAX_HASHTAGS is raised past 99."""
    assert check_rules("hashtag 1-99", ["#a"]) == []


def test_the_lab_event_body_is_exactly_what_the_script_posts() -> None:
    event = check_rules("hashtag 1-1", ["#a", "no tag"])[0]
    assert event.to_lab_event().to_wire() == {
        "type": "rule_check",
        "phase": "rule",
        "outcome": "flagged",
        "summary": "hashtag count 1-1: 1/2 posts adherent (50%)",
        "metrics": {"rule": "hashtag_count", "passRate": 0.5, "checked": 2},
    }


def test_both_rules_emit_in_hashtag_then_exclamation_order() -> None:
    events = check_rules("hashtag 1-2\n我不用感叹号\n", ["#a", "#a #b!", "plain"])
    assert [(e.rule, e.passes) for e in events] == [("hashtag_count", 2), ("no_exclamation", 2)]


def test_a_rule_event_cannot_be_built_over_an_empty_sample() -> None:
    """`checked > 0` is a model invariant, not a caller courtesy: `rate`
    divides by it, and "0/0 posts adherent" is a measurement of nothing."""
    with pytest.raises(ValidationError):
        RuleEvent(rule="hashtag_count", passes=0, checked=0, detail="x")


# ── nothing to say ───────────────────────────────────────────────────────


def test_no_posts_yields_no_hashtag_event() -> None:
    assert check_rules("hashtag 1-2", []) == []


def test_no_posts_yields_no_exclamation_event() -> None:
    """The second of the two independent empty-sample guards. Without it this
    is the path that would try to build a 0/0 event every round, for every
    account whose posts have aged out of the sampled window."""
    assert check_rules("我不用感叹号", []) == []


def test_a_document_stating_no_parseable_rule_yields_nothing() -> None:
    assert check_rules("## 身份\n一个喜欢读论文的账号\n", ["#a", "hi!"]) == []


# ── post extraction ──────────────────────────────────────────────────────


def test_original_text_wins_over_text() -> None:
    """`originalText` is the body the agent actually wrote, so it is the text
    its own rules were about."""
    assert extract_posts([{"originalText": "wrote", "text": "rendered"}]) == ["wrote"]


def test_text_is_used_when_original_text_is_absent_or_empty() -> None:
    assert extract_posts([{"text": "rendered"}, {"originalText": "", "text": "r2"}]) == [
        "rendered",
        "r2",
    ]


def test_blank_and_whitespace_only_posts_are_dropped() -> None:
    assert extract_posts([{"text": "  \n "}, {"text": "kept"}, {}]) == ["kept"]


def test_a_kept_post_is_stored_verbatim_not_stripped() -> None:
    """`posts.append(t)` -- `strip()` decides WHETHER to keep the post, never
    what is kept (rule-check.sh:60-61). Neither rule shipping today can tell
    the difference, so this is the only place the distinction is observable;
    it stops being cosmetic the moment a rule cares about post length or
    leading layout."""
    assert extract_posts([{"text": "  #a keeps its padding  "}]) == ["  #a keeps its padding  "]


def test_a_non_string_body_is_ignored_rather_than_raising() -> None:
    """This module may never turn a surprising payload into a round failure."""
    assert extract_posts([{"originalText": 7}, {"text": "kept"}]) == ["kept"]


# ── run_rule_check ───────────────────────────────────────────────────────

_PERSONALITY = "- **Username:** quantum\n\n## 风格\nhashtag 1-2 个\n我不用感叹号\n"


def _account(tmp_path: Path, *, personality: str = _PERSONALITY, key: bool = True) -> Path:
    # The folder name is deliberately NOT the username: `agent/agents/<dir>`
    # and the `Username` bullet genuinely differ on live accounts, and every
    # HTTP call below is keyed on the username, never on the folder.
    directory = tmp_path / "quant-dir"
    directory.mkdir()
    (directory / "personality.md").write_text(personality, encoding="utf-8")
    if key:
        (directory / "api_key.txt").write_text("secret-key\n", encoding="utf-8")
    return directory


def _resources(handler: object, requests: list[httpx.Request]) -> Resources:
    def record(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert callable(handler)
        response = handler(request)
        assert isinstance(response, httpx.Response)
        return response

    client = ApiClient(
        "https://example.test", ApiKeyAuth("k"), transport=httpx.MockTransport(record)
    )
    return Resources(client)


def _posts_payload(*texts: str) -> dict[str, object]:
    return {"data": {"items": [{"originalText": t} for t in texts]}}


def test_an_empty_original_text_reaches_the_whole_rule_path(tmp_path: Path) -> None:
    """Spec §15.5's other half, pinned at the CALL SITE.

    `rule-check.sh:59` is embedded Python -- `originalText or text` -- so an
    empty `originalText` DOES fall back and the post is scored.
    `behavior-snapshot.sh:65` is jq `//`, where an empty string is truthy, so
    the same item is dropped there
    (`test_an_empty_original_text_is_dropped_by_the_whole_behaviour_path`).

    Pinned through `run_rule_check` and not only through `extract_posts`,
    because the refactor that breaks this swaps the CALL, not the helper: a
    shared `select_post_texts` here would silently stop scoring such a post
    and quietly shrink every adherence denominator on `/lab`'s F4 panel.
    """
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(
                200, json={"data": {"items": [{"originalText": "", "text": "#a rendered"}]}}
            )
        return httpx.Response(201, json={"data": {"event": {"id": "e1"}}})

    events = run_rule_check(
        _resources(handler, seen), directory=_account(tmp_path), username="quantum"
    )

    assert [e.rule for e in events] == ["hashtag_count", "no_exclamation"]
    # `checked == 1` is the whole claim: the post was SEEN. A behaviour-style
    # extraction would have produced an empty sample and no events at all.
    assert {e.checked for e in events} == {1}


def test_a_full_run_reads_the_named_user_and_posts_one_event_per_rule(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            # Chosen so the two rules score DIFFERENTLY (4/4 vs 3/4) and land on
            # opposite sides of the outcome boundary: a sample where both rules
            # happen to agree cannot tell the two bodies apart.
            return httpx.Response(200, json=_posts_payload("#a", "#a #b", "#a!", "#b"))
        return httpx.Response(201, json={"data": {"event": {"id": "e1"}}})

    events = run_rule_check(
        _resources(handler, seen), directory=_account(tmp_path), username="quantum"
    )

    assert [e.rule for e in events] == ["hashtag_count", "no_exclamation"]
    assert seen[0].method == "GET"
    assert seen[0].url.path == "/api/v1/users/quantum/posts"
    # Both events reach the wire, each with its OWN body -- posting the first
    # one twice, or the same body under two rule names, would pass an
    # "len(seen) == 3" check on its own.
    assert [r.url.path for r in seen[1:]] == ["/api/v1/agents/quantum/events"] * 2
    bodies = [json.loads(r.content) for r in seen[1:]]
    assert bodies[0]["metrics"] == {"rule": "hashtag_count", "passRate": 1.0, "checked": 4}
    assert bodies[0]["outcome"] == "success"
    assert bodies[1]["metrics"] == {"rule": "no_exclamation", "passRate": 0.75, "checked": 4}
    assert bodies[1]["outcome"] == "flagged"
    assert bodies[1]["summary"] == "no exclamation mark: 3/4 posts adherent (75%)"


def test_the_post_fetch_uses_the_default_limit_of_twelve(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_posts_payload())

    run_rule_check(_resources(handler, seen), directory=_account(tmp_path), username="quantum")
    assert seen[0].url.params["limit"] == "12"
    assert DEFAULT_POST_LIMIT == 12


def test_an_explicit_limit_reaches_the_wire(tmp_path: Path) -> None:
    """5 is neither the default nor `Resources.user_posts`'s own default, so a
    dropped argument shows up here rather than coinciding with one."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_posts_payload())

    run_rule_check(
        _resources(handler, seen), directory=_account(tmp_path), username="quantum", limit=5
    )
    assert seen[0].url.params["limit"] == "5"


def test_a_missing_api_key_skips_the_account_without_any_request(tmp_path: Path) -> None:
    """rule-check.sh:38 exits 0 here. `personality.md` IS present, so a gate
    that checked the wrong filename would sail past this."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
        raise AssertionError("no request may be made without an api key")

    directory = _account(tmp_path, key=False)
    assert run_rule_check(_resources(handler, seen), directory=directory, username="quantum") == []
    assert seen == []


def test_an_unreachable_platform_emits_nothing_and_does_not_raise(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """`curl ... || echo ''` (rule-check.sh:41-43). Reporting 0% adherence
    because the network was down is the failure this module exists to avoid --
    and the log has to say WHICH of the two silences this was."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    directory = _account(tmp_path)
    with caplog.at_level(logging.INFO, logger="swil_agent.analysis.rule_check"):
        events = run_rule_check(_resources(handler, seen), directory=directory, username="quantum")
    assert events == []
    assert len(seen) == 1
    assert "rule-check: quant-dir — could not fetch posts; nothing to check" in caplog.messages


def test_a_five_hundred_on_the_post_fetch_emits_nothing_and_does_not_raise(
    tmp_path: Path,
) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    directory = _account(tmp_path)
    assert run_rule_check(_resources(handler, seen), directory=directory, username="quantum") == []
    assert [r.method for r in seen] == ["GET"]


def test_a_document_with_no_parseable_rule_posts_nothing_and_says_so(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The log line matters as much as the silence: "nothing to check" is how
    an operator reading the round log tells "this account states no
    machine-checkable rule" apart from "the measurement pass never ran"."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_posts_payload("#a", "hi!"))

    directory = _account(tmp_path, personality="- **Username:** quantum\n\n只是一些散文。\n")
    with caplog.at_level(logging.INFO, logger="swil_agent.analysis.rule_check"):
        events = run_rule_check(_resources(handler, seen), directory=directory, username="quantum")
    assert events == []
    assert [r.method for r in seen] == ["GET"]
    assert (
        "rule-check: quant-dir — no parseable rules or no posts; nothing to check"
        in caplog.messages
    )


def test_a_rejected_lab_event_never_reaches_the_caller(tmp_path: Path) -> None:
    """`|| true` on the emit loop (rule-check.sh:139). A /lab outage must not
    become a round failure -- and the events are still returned, so a caller
    can log what it measured."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=_posts_payload("#a"))
        return httpx.Response(503, text="lab down")

    directory = _account(tmp_path)
    events = run_rule_check(_resources(handler, seen), directory=directory, username="quantum")
    assert [e.rule for e in events] == ["hashtag_count", "no_exclamation"]
    # The 503 on the first emit does not abort the loop either: the second
    # event is still attempted.
    assert [r.method for r in seen] == ["GET", "POST", "POST"]


def test_the_rules_come_from_personality_md_and_are_re_read_on_every_call(
    tmp_path: Path,
) -> None:
    """The file is read HERE, not taken from an already-loaded Persona, which
    is what makes the call ORDER load-bearing: cycle-one.sh:39-41 runs this
    before the dream because the dream rewrites this exact file, and sampling
    afterwards measures the new rules against the old posts."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=_posts_payload("#a #b #c"))
        return httpx.Response(201, json={"data": {"event": {"id": "e"}}})

    directory = _account(tmp_path, personality="hashtag 3-4 个\n")
    # A decoy carrying a DIFFERENT rule, so reading the wrong file in this
    # directory is distinguishable from reading the right one.
    (directory / "memory.md").write_text("hashtag 1-1 个\n", encoding="utf-8")
    resources = _resources(handler, seen)

    first = run_rule_check(resources, directory=directory, username="quantum")
    assert [(e.detail, e.outcome) for e in first] == [("hashtag count 3-4", "success")]

    (directory / "personality.md").write_text("hashtag 1-1 个\n", encoding="utf-8")
    second = run_rule_check(resources, directory=directory, username="quantum")
    assert [(e.detail, e.outcome) for e in second] == [("hashtag count 1-1", "flagged")]


def test_the_emitted_summaries_are_logged(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=_posts_payload("#a", "#a #b"))
        return httpx.Response(201, json={"data": {"event": {"id": "e"}}})

    with caplog.at_level(logging.INFO, logger="swil_agent.analysis.rule_check"):
        run_rule_check(_resources(handler, []), directory=_account(tmp_path), username="quantum")
    assert "rule-check: hashtag count 1-2: 2/2 posts adherent (100%)" in caplog.messages


def test_the_skip_paths_say_which_account_and_why(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The folder name, matching `$NAME` in the script's own three messages."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_posts_payload("#a"))

    with caplog.at_level(logging.INFO, logger="swil_agent.analysis.rule_check"):
        run_rule_check(
            _resources(handler, []),
            directory=_account(tmp_path, key=False),
            username="quantum",
        )
    assert "rule-check: no api_key.txt for quant-dir — skipping" in caplog.messages
