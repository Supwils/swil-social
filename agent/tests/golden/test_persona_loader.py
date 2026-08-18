"""Golden tests: the loader must agree with the live Bash runtime on all 23
real accounts.

Expectations here are DERIVED FROM THE FILES AT TEST TIME, not hardcoded. An
earlier version of this test kept a hand-maintained `EXPECTED_BACKEND` map
(one literal value per account) and broke on the very first run: it expected
mangniu's `AI Backend` bullet to be `"haiku"`, but this worktree's committed
files have no such bullet for mangniu at all -- only `- **Model:** haiku`.

That was not a parser bug and not a genuinely conflicting fact about
mangniu -- it was two different trees. IN THE COMMITTED TREE this worktree
resolves against, mangniu has no `AI Backend` bullet -- not in
`personality.md`, its full archive, or the committed HEAD revision. That is
NOT true of every tree: mangniu's `AI Backend: haiku` bullet DOES exist,
right now, in the `main` checkout's working tree -- it is simply
uncommitted there, so this worktree (which only sees committed content)
never observes it. The original task-4 brief's `EXPECTED_BACKEND` map was
captured from that main working tree, not from this worktree's commit --
hence the mismatch. This also closes the open question about the CLAUDE.md
memory note that mangniu's DB-recorded `agentBackend` is `"haiku:haiku"`:
the live runtime reads the main working tree, where both bullets exist, so
that record is unsurprising and not an anomaly worth chasing further.

Because "an unrecognised `AI Backend` value passes through byte-for-byte,
with no normalisation" is exactly the property mangniu's real bullet
exists to protect, and this worktree's committed tree currently has zero
accounts exercising it, `test_nonstandard_backend_value_round_trips_verbatim_synthetic`
below pins the same property with a synthetic fixture so it is never
dormant -- see that test's docstring for the full rationale.

Two more lessons from later review rounds, both examples of "a test that
passes under the broken implementation": (1) `Model`/`Board`/`Read` were
parsed by the loader but asserted on by nothing -- see
`test_model_board_read_land_in_the_right_attribute_synthetic` and
`test_model_board_read_match_independent_bash_reimplementation`. (2) the
original `agents/`-vs-`humans/` precedence test resolved an account
("chongkai") that has no competing `agents/` directory, so it passed
identically regardless of which cohort `resolve_agent_dir` checked first --
see the rewritten `test_resolve_prefers_agents_over_humans`, which builds
both directories with distinguishable content so precedence is actually
exercised.

The structural lesson: a hardcoded per-account map is the wrong shape of
golden test. `personality.md` files are rewritten by accepted dreams on a
recurring basis, and even before that, "which tree am I reading" is enough
to break a frozen snapshot. A golden test here should prove the PARSER
REPRODUCES THE BASH RULE, not freeze one moment of the roster. So instead of
a hardcoded map, `_bash_get_field` below is an independent
re-implementation of `_get_field` (`agent/scripts/swil.sh:54`), written
directly from the Bash source and sharing no code with
`swil_agent.persona.loader`. Each test derives its expected value from
whatever the real file says at run time, so it holds regardless of which
tree, or which round of dreams, produced the current roster -- and a bug
shared between the parser and its test oracle can't hide behind a passing
test, because the oracle is a second, independent implementation.
"""

import re
from pathlib import Path

import pytest

from swil_agent.persona.loader import get_field, get_section, load_persona, resolve_agent_dir

AGENT_ROOT = Path(__file__).resolve().parents[2]

ALL_ACCOUNTS = [
    "chawendao",
    "darkpool",
    "fenziys",
    "liushang",
    "moguan",
    "qianxian",
    "qiusai",
    "quant",
    "shengyin",
    "shunteng",
    "sketch",
    "vex",
    "xianying",
    "zenith",
    "zhuiyi",
    "chongkai",
    "hodlge",
    "lvchuang",
    "mangniu",
    "maobian",
    "tulingshe",
    "yingying",
    "zaofan",
]


def _bash_get_field(text: str, field: str) -> str | None:
    r"""Independent re-implementation of `_get_field` from
    `agent/scripts/swil.sh:54`:

        _get_field() {
          grep -i "^\- \*\*${2}:\*\*" "$1" | sed 's/.*\*\* //' | tr -d '[:space:]'
        }

    Written straight from that three-stage Bash pipeline (grep -> sed -> tr),
    NOT by calling `swil_agent.persona.loader.get_field`. A differential test
    whose oracle shares code with the implementation under test cannot catch
    a bug the two share -- this must stand on its own.
    """
    # grep -i "^\- \*\*<field>:\*\*" -- every matching line, in file order.
    grep_pattern = re.compile(
        r"^- \*\*" + re.escape(field) + r":\*\*.*$", re.IGNORECASE | re.MULTILINE
    )
    matched_lines = grep_pattern.findall(text)
    if not matched_lines:
        return None
    # sed 's/.*\*\* //' -- on each matched line, drop everything through the
    # last "** " (greedy match mirrors sed's greedy .*).
    sed_strip = re.compile(r"^.*\*\* ")
    stripped_lines = [sed_strip.sub("", line) for line in matched_lines]
    # tr -d '[:space:]' -- delete ALL whitespace from the joined stream
    # (this also removes the newlines between separately matched lines,
    # matching the real pipeline's behavior of concatenating them).
    value = re.sub(r"\s", "", "".join(stripped_lines))
    return value or None


def _write_synthetic_persona(
    directory: Path,
    *,
    username: str = "synthetic_user",
    bio: str = "exists only to exercise the loader in isolation.",
    backend: str = "claude",
    model: str = "sonnet",
    board: str = "general",
    read: str = "narrow",
) -> None:
    """Write a complete, valid personality.md into `directory` with the given
    field values. Used only by synthetic tests below -- never touches the
    real roster. Every field the loader parses gets a bullet so callers can
    override any subset without producing a structurally incomplete file."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "personality.md").write_text(
        "# Synthetic\n\n"
        "## 身份\n"
        f"- **Username:** {username}\n"
        "- **Display Name:** Synthetic User\n"
        "- **Headline:** a test fixture, not a real account\n"
        f"- **Bio:** {bio}\n"
        "- **Follow Topics:** testing,fixtures\n"
        f"- **AI Backend:** {backend}\n"
        f"- **Model:** {model}\n"
        f"- **Board:** {board}\n"
        f"- **Read:** {read}\n\n"
        "## 发帖节律\n"
        "post whenever the test needs it.\n",
        encoding="utf-8",
    )


def test_all_23_accounts_resolve() -> None:
    for name in ALL_ACCOUNTS:
        assert resolve_agent_dir(AGENT_ROOT, name).is_dir()


def test_resolve_prefers_agents_over_humans(tmp_path: Path) -> None:
    """`resolve_agent_dir` checks `agents/` before `humans/` (mirrors
    `dream.sh`'s `_find_dir`) -- a stray `agents/<name>` therefore shadows a
    `humans/<name>` account. See the 2026-08 incident.

    The previous version of this test resolved "chongkai" and asserted the
    result was under `humans/`. But `agent/agents/chongkai` does not exist,
    so there was no competing directory: the assertion held identically
    whether `resolve_agent_dir` checked `("agents", "humans")` or
    `("humans", "agents")`. It could not fail on the regression it named.

    Build BOTH cohort directories for one synthetic account name here, with
    distinguishable content (different Username and Bio), so precedence is
    actually exercised. Assert on the returned path's parent AND on content
    loaded from it, so a wrong-cohort read fails loudly rather than
    silently returning a directory whose contents nobody checked."""
    name = "dup_account"
    agents_dir = tmp_path / "agents" / name
    humans_dir = tmp_path / "humans" / name
    _write_synthetic_persona(agents_dir, username="agents_cohort_user", bio="agents cohort bio")
    _write_synthetic_persona(humans_dir, username="humans_cohort_user", bio="humans cohort bio")

    resolved = resolve_agent_dir(tmp_path, name)

    assert resolved.parent.name == "agents"
    p = load_persona(resolved)
    assert p.username == "agents_cohort_user"
    assert p.bio == "agents cohort bio"


def test_resolve_raises_for_unknown_account() -> None:
    with pytest.raises(FileNotFoundError):
        resolve_agent_dir(AGENT_ROOT, "no_such_account")


@pytest.mark.parametrize("name", ALL_ACCOUNTS)
def test_every_account_loads_with_a_username(name: str) -> None:
    p = load_persona(resolve_agent_dir(AGENT_ROOT, name))
    assert p.username, f"{name} has no Username bullet"
    assert p.raw, f"{name} loaded empty"


@pytest.mark.parametrize("name", ALL_ACCOUNTS)
def test_backend_matches_independent_bash_reimplementation(name: str) -> None:
    """Differential test: derive the expected `AI Backend` value straight from
    the raw file via `_bash_get_field` (written independently from
    `agent/scripts/swil.sh`, not from `loader.py`). The parser must reproduce
    that value verbatim when the bullet is present, and fall back to
    "claude" when it is absent -- for every account, read fresh each run."""
    directory = resolve_agent_dir(AGENT_ROOT, name)
    raw = (directory / "personality.md").read_text(encoding="utf-8")
    expected = _bash_get_field(raw, "AI Backend") or "claude"
    p = load_persona(directory)
    assert p.backend == expected


def test_accounts_without_an_ai_backend_bullet_default_to_claude() -> None:
    """The roster contains at least one account with no `AI Backend` bullet
    at all (see module docstring). Every such account must default to
    "claude" -- not raise, not silently invent a different value. Written
    generically so it holds regardless of which accounts currently lack the
    bullet."""
    missing = [
        name
        for name in ALL_ACCOUNTS
        if _bash_get_field(
            (resolve_agent_dir(AGENT_ROOT, name) / "personality.md").read_text(encoding="utf-8"),
            "AI Backend",
        )
        is None
    ]
    assert missing, "expected at least one account with no AI Backend bullet in this tree"
    for name in missing:
        p = load_persona(resolve_agent_dir(AGENT_ROOT, name))
        assert p.backend == "claude", f"{name} has no AI Backend bullet but backend != 'claude'"


def test_nonstandard_backend_values_round_trip_verbatim() -> None:
    """Any account whose `AI Backend` bullet is not one of the three known
    backend names must still parse VERBATIM -- the loader must never
    normalise or "correct" an unexpected value (this roster has carried such
    a value before; see module docstring). Written generically, without
    naming any specific account, so it exercises whichever accounts (if any)
    currently carry a nonstandard value."""
    known = {"claude", "codex", "deepseek"}
    for name in ALL_ACCOUNTS:
        directory = resolve_agent_dir(AGENT_ROOT, name)
        raw = (directory / "personality.md").read_text(encoding="utf-8")
        value = _bash_get_field(raw, "AI Backend")
        if value is not None and value not in known:
            p = load_persona(directory)
            assert p.backend == value, f"{name}: expected verbatim {value!r}, got {p.backend!r}"


@pytest.mark.parametrize("backend_value", ["haiku", "SomeThing-Weird_42"])
def test_nonstandard_backend_value_round_trips_verbatim_synthetic(
    tmp_path: Path, backend_value: str
) -> None:
    """`test_nonstandard_backend_values_round_trip_verbatim` above is a
    roster-driven guard that is DORMANT today: no account currently
    committed to this tree carries an `AI Backend` value outside
    {claude, codex, deepseek}, so that test's body executes zero times. A
    future change that normalised unknown values to "claude" would ship
    green with nothing in the suite to catch it.

    "An unrecognised AI Backend value passes through byte-for-byte, with no
    normalisation" is exactly the property mangniu's real bullet exists to
    protect -- mangniu carries `- **AI Backend:** haiku` right now in the
    `main` checkout's working tree (uncommitted; this worktree's committed
    tree does not have it, see module docstring). Since that real-world case
    isn't committed here, this test builds an equivalent synthetic account
    so the property is always exercised, independent of which tree or which
    round of dreams produced the current roster:

    - `"haiku"` pins the exact mangniu-shaped case: a real model-tier word
      that is nonetheless not one of the three known backend names, and must
      come back exactly as `"haiku"` -- not `"claude"`, not massaged.
    - `"SomeThing-Weird_42"` is not a plausible backend name at all, which
      pins "no normalisation" as the general rule rather than "haiku
      happens to be on an allowlist".
    """
    directory = tmp_path / "synthetic_account"
    _write_synthetic_persona(directory, backend=backend_value)
    p = load_persona(directory)
    assert p.backend == backend_value


def test_model_board_read_land_in_the_right_attribute_synthetic(tmp_path: Path) -> None:
    """`Model`, `Board`, and `Read` decide an account's model tier, feed
    scope, and read width -- before this test, nothing in the suite
    asserted on `p.model`, `p.board`, or `p.read` at all (only docstring
    prose and `_write_synthetic_persona`'s unchecked default). A bug that
    swapped the `"Board"` and `"Read"` field-name literals in `loader.py`
    would still ship two non-None strings and pass every existing check.

    Use distinct, non-overlapping values for the three fields so a
    swapped-field bug is caught by a value landing in the WRONG attribute,
    not just a value going missing."""
    directory = tmp_path / "control_fields_account"
    _write_synthetic_persona(directory, model="opus", board="making", read="wide")
    p = load_persona(directory)
    assert p.model == "opus"
    assert p.board == "making"
    assert p.read == "wide"


@pytest.mark.parametrize("name", ALL_ACCOUNTS)
def test_model_board_read_match_independent_bash_reimplementation(name: str) -> None:
    """Roster-driven counterpart to the synthetic test above: derive each of
    `Model`/`Board`/`Read` straight from the raw file via `_bash_get_field`
    (independent of `loader.py`, see module docstring), and assert the
    parsed `Persona` attribute matches -- `None` when the bullet is absent.
    Read fails the most quietly of the three: this roster has 23/23 accounts
    with a `Board` bullet, 19/23 with `Model`, and only 1/23 with `Read`, so
    without this test a lost or misrouted `Read` value would go unnoticed by
    every other test in this file."""
    directory = resolve_agent_dir(AGENT_ROOT, name)
    raw = (directory / "personality.md").read_text(encoding="utf-8")
    p = load_persona(directory)
    assert p.model == _bash_get_field(raw, "Model")
    assert p.board == _bash_get_field(raw, "Board")
    assert p.read == _bash_get_field(raw, "Read")


@pytest.mark.parametrize("name", ALL_ACCOUNTS)
def test_every_account_has_at_least_two_follow_topics(name: str) -> None:
    p = load_persona(resolve_agent_dir(AGENT_ROOT, name))
    assert len(p.follow_topics) >= 2


@pytest.mark.parametrize("name", ALL_ACCOUNTS)
def test_every_account_has_a_rhythm_section(name: str) -> None:
    p = load_persona(resolve_agent_dir(AGENT_ROOT, name))
    assert p.rhythm_text.strip(), f"{name} has an empty 发帖节律 section"


def test_get_field_is_case_insensitive_and_first_match_wins() -> None:
    text = "- **username:** first\n- **Username:** second\n"
    assert get_field(text, "Username") == "first"


def test_get_field_returns_none_when_absent() -> None:
    assert get_field("- **Other:** x\n", "Username") is None


def test_get_section_stops_at_the_next_heading() -> None:
    text = "## A\nline1\nline2\n## B\nline3\n"
    assert get_section(text, "A") == "line1\nline2"
    assert get_section(text, "B") == "line3"
    assert get_section(text, "Missing") == ""


def test_get_section_matches_a_heading_with_an_appended_suffix() -> None:
    """A dream that renames the heading with a suffix (e.g. a parenthetical
    annotation tacked onto "发帖节律") passes both Bash validators
    (`awk '/^## 发帖节律/'` in `build_rhythm_guidance`, `grep -q '^## 发帖节律'`
    in dream.sh) because neither anchors the end of the pattern.
    `get_section` must match by the same prefix rule or the section
    silently reads as empty."""
    text = "## 发帖节律（本轮微调）\n- 每次触发有 90% 概率选择 post\n## 下一节\nx\n"
    assert get_section(text, "发帖节律") == "- 每次触发有 90% 概率选择 post"


def test_get_section_prefers_an_exact_match_over_a_longer_unrelated_heading() -> None:
    """Guard against over-loosening: raw prefix matching is asymmetric --
    `"身份认同"` starts with `"身份"`, so a naive single-pass prefix search
    could return the WRONG section when both an exact `## 身份` and an
    unrelated, longer `## 身份认同` heading exist in the same document
    (arbitrating between two real, independently-titled sections is not
    what prefix matching is for). An exact match must always win, regardless
    of which heading appears first in the document."""
    # "身份认同" appears BEFORE the exact "身份" heading, the case a naive
    # single-pass "first prefix match wins" implementation would get wrong.
    text = "## 身份认同\nwrong section\n## 身份\nright section\n"
    assert get_section(text, "身份") == "right section"
