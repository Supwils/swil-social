"""Parse `personality.md` into a typed Persona.

Follows `agent/scripts/swil.sh:_get_field` on the parts that matter: a field
is a line matching `- **<Field>:** <value>`, matched case-insensitively, first
occurrence wins. Malformed bullets are preserved verbatim — normalising them
here would silently change an experiment control value.

ONE deliberate departure, and it is not "exactly", which is what this docstring
used to claim. Bash's `_get_field` ends in `tr -d '[:space:]'`, deleting every
whitespace character in the value rather than only the ends — so Bash's
`Display Name`, `Headline` and `Bio` come back with their internal spaces gone.
`get_field` below strips the ends only, because those three fields are prose
that Bash never renders on the login path and that `tr` would turn into
unreadable runs. The field where Bash's collapse is observable TODAY — it feeds
a search query and a heading — is `Follow Topics`, and `_split_topics`
reproduces `tr` for it on every input the roster can currently produce, which is
weaker than "exactly" and is the honest claim. See that function for the two
codepoint classes and the one locale where the two disagree.

§7 CONDITIONS on the rest of the fields, so nobody reads the paragraph above as
"only prose is affected":

  * `Username`, `Board` and `Read` are collapse-observable in principle — Bash
    puts `Board` straight into a `/feed/board/{slug}` URL (`swil.sh:334`) and
    compares `Read` against the `global` sentinel, so an internal space would
    make the two runtimes request different URLs and select different arms.
    They are inert only because **0 of the 23 accounts** have internal
    whitespace in any of the three. That expires the day a dream, or a hand
    edit, writes `- **Board:** ai governance`.
  * `Display Name` / `Headline` / `Bio` stay end-stripped deliberately, and
    that IS a real divergence from Bash. `setup-agents.sh:24` and
    `setup-humans.sh:18` carry their own copy of the collapsing `_get_field`
    and register accounts with `Display Name` run through it. It is invisible
    twice over: no roster display name has internal whitespace, and Python
    never CONSUMES `display_name`, `headline` or `bio` — they are parsed onto
    `Persona` and read by nothing. Both halves would have to change before
    this mattered.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path

from swil_agent.models import Persona

_DEFAULT_BACKEND = "claude"


def get_field(text: str, field: str) -> str | None:
    pattern = re.compile(
        r"^-\s+\*\*" + re.escape(field) + r":\*\*\s*(.*)$",
        re.IGNORECASE | re.MULTILINE,
    )
    m = pattern.search(text)
    if m is None:
        return None
    value = m.group(1).strip()
    return value or None


def _iter_sections(text: str) -> Iterator[tuple[str, list[str]]]:
    """Yield (heading_text, body_lines) for every `## ` heading block in `text`,
    in document order. `heading_text` is the raw text after `## `, stripped."""
    heading: str | None = None
    body: list[str] = []
    for line in text.splitlines():
        if line.startswith("## "):
            if heading is not None:
                yield heading, body
            heading = line[3:].strip()
            body = []
        elif heading is not None:
            body.append(line)
    if heading is not None:
        yield heading, body


def get_section(text: str, heading: str) -> str:
    """Return the body of the `## <heading>` section.

    Matches by PREFIX, mirroring both Bash consumers: `auto-run.sh`'s
    `build_rhythm_guidance` extracts the section with
    `awk '/^## 发帖节律/'`, and `dream.sh`'s structural validator checks it
    with `grep -q '^## 发帖节律'` — both match any heading line that STARTS
    WITH the target text, with no anchor at the end. So a dream that renames
    the heading with an appended suffix (e.g. a parenthetical annotation
    tacked onto "发帖节律") still passes Bash's validator and lands on disk;
    this must recognise it too, or the section silently reads as empty and
    `decide_rhythm` falls back to `RhythmPolicy.FREE` — the one state
    CLAUDE.md says to avoid.

    An EXACT heading match always wins over a prefix match, checked as two
    full passes over the document rather than one. This matters because raw
    prefix matching is asymmetric: a longer, wholly different heading can
    start with a shorter query (`"身份认同"` starts with `"身份"`), but never
    the reverse. Without the exact-first rule, looking up `"身份"` in a
    document that also happens to contain an unrelated `"## 身份认同"`
    section could return the WRONG section — arbitrating between two
    real, independently-titled headings, which prefix matching was never
    meant to do. Preferring an exact match first means that ambiguity only
    matters when no exact match exists at all, which is exactly the
    suffixed-heading case this function exists to handle.
    """
    target = heading.strip()
    sections = list(_iter_sections(text))
    for candidate_heading, body in sections:
        if candidate_heading == target:
            return "\n".join(body).strip()
    for candidate_heading, body in sections:
        if candidate_heading.startswith(target):
            return "\n".join(body).strip()
    return ""


def _split_topics(raw: str | None) -> list[str]:
    """`swil.sh:387`'s `IFS=',' read -ra` over a `_get_field` value.

    Bash deletes the whitespace BEFORE it splits: `_get_field` (`swil.sh:55`)
    ends in `tr -d '[:space:]'`, which removes every whitespace character in
    the field — inside a topic as well as around it — and only then does
    `IFS=','` cut it up. Stripping each element's ends is a different
    function, and the difference is live on this roster:
    `agent/agents/sketch` (`Username: diannaokun`) declares `AI 行业`,
    `AI Agent 叙事` and `AI 治理话术`, three of its thirteen topics.

    That is not cosmetic. Each topic is BOTH the `/posts/search?q=` query and
    the `## #<topic>` heading in the rendered feed, so `AI 行业` and `AI行业`
    fetch different posts and write different bytes into the prompt — an R28
    divergence on the very channel R28 exists to protect. Bash's collapse
    also happens to be the reason multi-word topics behave at all: it is what
    the four years of `feed_for_diannaokun.md` on disk were searched with.

    Scoped to this field rather than applied inside `get_field` on purpose;
    `follow_topics` has exactly one consumer (`render_follow_topics_feed`),
    while `get_field` also serves the prose fields the module docstring
    names.

    `str.split()` splits on Unicode whitespace, deliberately rather than a
    space-only replace: BSD `tr` under `en_US.UTF-8` deletes U+3000
    IDEOGRAPHIC SPACE and U+00A0 as readily as an ASCII space, and a
    `replace(" ", "")` would not. `test_topic_whitespace_is_deleted_the_way_
    tr_deletes_it` pins that, because no roster bullet contains either
    character and a space-only collapse would otherwise pass every test here.

    §7 CONDITIONS — this is a match on today's inputs, not an identity. Two
    ways the two functions provably disagree, both measured against `tr` on
    this machine rather than reasoned about:

      * **Five codepoints, in every locale.** `str.split()` treats U+001C,
        U+001D, U+001E, U+001F (the ASCII file/group/record/unit separators)
        and U+0085 (NEL) as whitespace; POSIX `[:space:]` does not, so `tr`
        leaves all five in place. A topic containing one would be collapsed
        here and not by Bash. No roster bullet contains one — they are
        unprintable — which is exactly why this is a note rather than a bug.
      * **Locale.** The agreement on U+3000 and U+00A0 is a property of a
        UTF-8 locale, not of `tr`: under `LC_ALL=C` BSD `tr` leaves both
        alone and Python still deletes them. That matters because
        `com.swil.heartbeat.plist` sets no `LANG`, so a launchd-run `swil.sh`
        can be in `C` while an interactive one is in `en_US.UTF-8` — the two
        runtimes would then disagree for a reason that has nothing to do with
        this code. Inert while no bullet carries a non-ASCII space; re-derive
        this note if one ever does.
    """
    if not raw:
        return []
    return [collapsed for t in raw.split(",") if (collapsed := "".join(t.split()))]


def resolve_agent_dir(agent_root: Path, name: str) -> Path:
    # agents/ is checked first, matching dream.sh::_find_dir. A stray
    # agents/<name> therefore shadows a humans/<name> account.
    for cohort in ("agents", "humans"):
        candidate = agent_root / cohort / name
        if (candidate / "personality.md").is_file():
            return candidate
    raise FileNotFoundError(f"no personality.md for account {name!r} under {agent_root}")


def load_persona(directory: Path) -> Persona:
    raw = (directory / "personality.md").read_text(encoding="utf-8")
    username = get_field(raw, "Username")
    if username is None:
        raise ValueError(f"{directory}/personality.md has no Username bullet")
    return Persona(
        username=username,
        display_name=get_field(raw, "Display Name"),
        headline=get_field(raw, "Headline"),
        bio=get_field(raw, "Bio"),
        follow_topics=_split_topics(get_field(raw, "Follow Topics")),
        backend=get_field(raw, "AI Backend") or _DEFAULT_BACKEND,
        declared_backend=get_field(raw, "AI Backend"),
        model=get_field(raw, "Model"),
        board=get_field(raw, "Board"),
        read=get_field(raw, "Read"),
        rhythm_text=get_section(raw, "发帖节律"),
        raw=raw,
        directory=directory,
    )
