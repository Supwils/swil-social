from swil_agent.persona.validators import validate_candidate

BASE = """# 测试

## 身份
- **Username:** tester
- **Display Name:** 测试
- **Headline:** AI Agent
- **Bio:** 一句话
- **Follow Topics:** alpha,beta,gamma

- **AI Backend:** claude
- **Model:** haiku
- **Board:** perception
- **Read:** wide

## 性格
一些文字

## 发帖节律
- 每次触发有 60% 概率选择 post
"""


def test_identical_candidate_passes() -> None:
    assert validate_candidate(BASE, BASE) is None


def test_bio_may_be_rewritten_freely() -> None:
    """Check 4 is existence-only. A dream MUST be allowed to rewrite Bio."""
    candidate = BASE.replace("- **Bio:** 一句话", "- **Bio:** 完全不同的一句话")
    assert validate_candidate(BASE, candidate) is None


def test_headline_and_display_name_may_be_rewritten() -> None:
    candidate = BASE.replace("- **Headline:** AI Agent", "- **Headline:** 新的头衔")
    candidate = candidate.replace("- **Display Name:** 测试", "- **Display Name:** 新名字")
    assert validate_candidate(BASE, candidate) is None


def test_headline_value_change_is_accepted() -> None:
    """Symmetric to test_bio_may_be_rewritten_freely: pins that the
    existence group is existence-only from the Headline side too, so the
    round-trip/existence split is tested from both directions."""
    candidate = BASE.replace("- **Headline:** AI Agent", "- **Headline:** 完全不同的头衔")
    assert validate_candidate(BASE, candidate) is None


def test_username_drift_fails() -> None:
    candidate = BASE.replace("- **Username:** tester", "- **Username:** someone_else")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "Username"


def test_backend_drift_fails() -> None:
    candidate = BASE.replace("- **AI Backend:** claude", "- **AI Backend:** codex")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "AI Backend"


def test_model_drift_fails() -> None:
    candidate = BASE.replace("- **Model:** haiku", "- **Model:** opus")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "Model"


def test_board_drift_fails() -> None:
    candidate = BASE.replace("- **Board:** perception", "- **Board:** making")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "Board"


def test_read_dropped_fails_the_quietest_control_field() -> None:
    """Losing `Read` turns the widest-input arm into an ordinary board reader
    with nothing in any log to say so. It must fail loudly."""
    candidate = BASE.replace("- **Read:** wide\n", "")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "Read"


def test_read_value_change_fails() -> None:
    """The deletion-shaped sibling test above cannot distinguish round-trip
    from existence-only grouping: dropping the whole `Read` line trips the
    'missing required field' branch just as reliably under either grouping,
    so it passes regardless of which group `Read` is in. A changed-but-still-
    present value is the failure mode that would otherwise pass silently
    under an existence-only grouping -- and it is exactly the quiet
    corruption this field is meant to guard against."""
    candidate = BASE.replace("- **Read:** wide", "- **Read:** narrow")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "Read"


def test_control_field_absent_from_original_is_not_a_failure() -> None:
    original = BASE.replace("- **Read:** wide\n", "")
    candidate = original
    assert validate_candidate(original, candidate) is None


def test_missing_bio_fails_existence_check() -> None:
    candidate = BASE.replace("- **Bio:** 一句话\n", "")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "Bio"


def test_missing_rhythm_section_fails() -> None:
    candidate = BASE.replace("## 发帖节律\n- 每次触发有 60% 概率选择 post\n", "")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "发帖节律"


def test_single_follow_topic_fails() -> None:
    candidate = BASE.replace("- **Follow Topics:** alpha,beta,gamma", "- **Follow Topics:** alpha")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "Follow Topics"


def test_two_follow_topics_pass() -> None:
    candidate = BASE.replace("- **Follow Topics:** alpha,beta,gamma", "- **Follow Topics:** a,b")
    assert validate_candidate(BASE, candidate) is None


def test_whitespace_differences_do_not_count_as_drift() -> None:
    candidate = BASE.replace("- **Username:** tester", "- **Username:**  tester ")
    assert validate_candidate(BASE, candidate) is None


def test_internal_whitespace_does_not_count_as_drift() -> None:
    """The sibling test above uses leading/trailing spaces, but
    `loader.get_field()` already `.strip()`s the captured value before
    `_normalised` ever sees it -- so that test would pass even if
    `_normalised` did no whitespace handling at all. Bash's
    `tr -d '[:space:]'` strips whitespace ANYWHERE in the value, including
    internal, which is what `_normalised`'s `re.sub` exists to reproduce.
    Only a space in the MIDDLE of the value exercises that equivalence."""
    candidate = BASE.replace("- **Username:** tester", "- **Username:** tes ter")
    assert validate_candidate(BASE, candidate) is None


def test_suffixed_rhythm_heading_still_passes_the_structural_validator() -> None:
    """`dream.sh`'s own structural check is `grep -q '^## 发帖节律'` -- a
    prefix match with no end anchor -- so a dream that appends a suffix to
    the heading (e.g. a parenthetical annotation tacked onto "发帖节律")
    already passes Bash's gate and lands on disk. `validate_candidate` must
    accept it too, or Python would reject dreams Bash has always accepted."""
    candidate = BASE.replace("## 发帖节律\n", "## 发帖节律（本轮微调）\n")
    assert validate_candidate(BASE, candidate) is None


def test_checks_run_in_declared_order() -> None:
    """Username drift AND a missing Bio: Username must be reported."""
    candidate = BASE.replace("- **Username:** tester", "- **Username:** other")
    candidate = candidate.replace("- **Bio:** 一句话\n", "")
    f = validate_candidate(BASE, candidate)
    assert f is not None
    assert f.check == "Username"
