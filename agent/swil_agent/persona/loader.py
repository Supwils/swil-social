"""Parse `personality.md` into a typed Persona.

Mirrors `agent/scripts/swil.sh:_get_field` exactly: a field is a line matching
`- **<Field>:** <value>`, matched case-insensitively, first occurrence wins.
Malformed bullets are preserved verbatim — normalising them here would
silently change an experiment control value.
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
    if not raw:
        return []
    return [t.strip() for t in raw.split(",") if t.strip()]


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
        model=get_field(raw, "Model"),
        board=get_field(raw, "Board"),
        read=get_field(raw, "Read"),
        rhythm_text=get_section(raw, "发帖节律"),
        raw=raw,
        directory=directory,
    )
