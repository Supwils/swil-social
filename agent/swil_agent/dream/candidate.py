"""The dream candidate path: cooldown gate, group-memory digest, the exact
prompt sent to the model, and cleanup of its raw reply into a candidate
`personality.md` body.

Source of truth is `agent/scripts/dream.sh` itself (read directly, lines
cited below), not `docs/superpowers/specs/2026-08-17-bash-runtime-contracts/
03-dream-candidate-and-snapshot.md` alone -- that contract has already been
caught transcribing this script wrong more than once (see its own README).

What this module deliberately does NOT do, because it belongs to a later
task: dispatch to an LLM backend (`llm.base.Backend` / `complete_text` --
task 12's `run_dream` calls those directly, using `render_dream_prompt`'s
output as the request), write `personality.md` or `personality.archive.md`,
or append the "dream | personality consolidated" housekeeping line to
`memory.md` (contract `03` §4 step 6). This module's `record_dream` writes
only the two on-disk cooldown markers (§4 steps 4-5) that precede that line;
see `record_dream`'s docstring for the ordering contract its caller must
preserve.

**Bash 3.2 brace-scanning check (see auto-run.sh's `${thread_context:+...}`
defect, fixed by commit `97b3021`):** dream.sh's two `${var:+...}` blocks --
`${group_memory:+...}` (dream.sh:596-604) and `${echo_hint:+...}`
(dream.sh:605-611) -- were checked for literal `{`/`}` characters inside
their expansion words. Neither
word contains one (the group-memory word's only structured text is a
heading, a variable reference, and a plain sentence; same for echo_hint's).
So the bash-3.2 "stops at the first unquoted `}`" mis-scan that corrupted
`auto-run.sh`'s thread section cannot recur here -- these two blocks were
never at risk of it. Reported per task-10-brief.md's instruction to check
and report either way.
"""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any, Final, Protocol

from swil_agent.models import CooldownDecision

# ── cooldown (contract 03 §1.3, dream.sh:479-510) ───────────────────────────

# Match `Settings.dream_cooldown_hours` / `Settings.dream_min_new_memories`
# (config.py) exactly -- kept as plain defaults here, not a `Settings`
# import, so `check_cooldown` stays a pure function of its arguments: task
# 12's `run_dream` is the one that actually holds a `Settings` instance and
# threads `settings.dream_cooldown_hours` / `settings.dream_min_new_memories`
# through when calling this.
_DEFAULT_COOLDOWN_HOURS: Final = 12
_DEFAULT_MIN_NEW_MEMORIES: Final = 8


class DreamState(Protocol):
    """Structural shape `check_cooldown` needs to read the two on-disk
    cooldown markers under STATE_DIR (`dream.sh:480` reads
    `last_dream_<name>`, `dream.sh:499-501` reads `last_dream_memlines_<name>`;
    contract `03` §1.3).

    The same seam `Runner` (llm/base.py) and `Embedder` (dream/distill.py)
    use elsewhere in this codebase: production reads real files
    (`FilesystemDreamState`, below); tests substitute
    `tests/unit/_runners.py`'s `FakeState`, which never touches a
    filesystem at all.

    `record_dream` was added to this Protocol by task 12 (`dream/round.py`):
    `FilesystemDreamState` already implemented it (below) with a docstring
    explicitly anticipating a caller, but the Protocol itself only declared
    the two READ methods `check_cooldown` needs. `run_dream` needs to call
    `record_dream` on whatever `DreamState` it was handed, typed, hence the
    addition here rather than a second, narrower Protocol in `dream/round.py`.
    """

    def last_dream_ts(self, name: str) -> int | None: ...

    def last_dream_memlines(self, name: str) -> int: ...

    def record_dream(self, name: str, *, at: int, memlines: int) -> None: ...


class FilesystemDreamState:
    """The real `DreamState`, backed by `<state_dir>/last_dream_<name>` and
    `<state_dir>/last_dream_memlines_<name>` -- the exact two files
    `dream.sh:852-853` writes and `dream.sh:480-501` reads.
    """

    def __init__(self, state_dir: Path) -> None:
        self._dir = state_dir

    def last_dream_ts(self, name: str) -> int | None:
        path = self._dir / f"last_dream_{name}"
        if not path.is_file():
            return None
        try:
            return int(path.read_text(encoding="utf-8").strip())
        except ValueError:
            return None

    def last_dream_memlines(self, name: str) -> int:
        path = self._dir / f"last_dream_memlines_{name}"
        if not path.is_file():
            return 0
        try:
            return int(path.read_text(encoding="utf-8").strip())
        except ValueError:
            return 0

    def record_dream(self, name: str, *, at: int, memlines: int) -> None:
        """Write contract `03` §4 steps 4-5 (`dream.sh:852-853`): the epoch
        marker, then the memlines snapshot.

        **Ordering contract the CALLER must preserve** (task 12's
        `run_dream`): this method must return, and its writes must be
        durable, BEFORE the caller appends the "<date> | dream | personality
        consolidated" housekeeping line to `memory.md` (contract `03` §4
        step 6, `dream.sh:856`). Bash writes the memlines marker first
        specifically so that appended line counts toward the NEXT round's
        "+N new memories" cooldown-override tally (§1.3) -- reproduced here,
        not fixed, because reversing it changes when every one of the 23
        real accounts' next dream fires. This method does not append to
        `memory.md` itself; that write, and enforcing this ordering around
        it, is `run_dream`'s job, not this module's.
        """
        (self._dir / f"last_dream_{name}").write_text(str(at), encoding="utf-8")
        (self._dir / f"last_dream_memlines_{name}").write_text(str(memlines), encoding="utf-8")


def check_cooldown(
    state: DreamState,
    name: str,
    *,
    auto: bool,
    memory_lines: int,
    now: int | None = None,
    cooldown_hours: int = _DEFAULT_COOLDOWN_HOURS,
    min_new_memories: int = _DEFAULT_MIN_NEW_MEMORIES,
) -> CooldownDecision:
    """Contract `03` §1.3 (`dream.sh:479-510`), two quirks pinned:

    1. **Narrow applicability.** The cooldown is evaluated ONLY when
       `auto` is true AND a `last_dream_<name>` marker already exists.
       A bare `dream.sh <name>` call (`auto=False`, "force" mode in the
       contract's terms) and any account's first-ever dream always
       proceed -- both return here before `state` is even asked for a
       memlines count.
    2. **Dead code, not reproduced.** `dream.sh:490-495` computes a
       second candidate gate value via an awk pass that counts only
       memory.md lines beginning with a `YYYY-MM-DD` date -- but that
       value (`new_lines` in the script) is never read again; the real
       gate three lines later (`dream.sh:502-503`) uses `tail_lines`, a
       PLAIN `wc -l` delta of the whole file. This function reproduces
       only `tail_lines`'s behaviour: `memory_lines` (the caller's
       current total line count) minus whatever `state` last recorded,
       full stop -- any appended line counts toward the override tally,
       dated or not, including the "personality consolidated"
       housekeeping line a previous dream itself wrote (see
       `FilesystemDreamState.record_dream`'s ordering note). Do not
       "restore" the awk's date-filtering here; it was never live in
       Bash either.

    Hours are FLOORED, not rounded: `(now - last) // 3600`, matching
    Bash's `(( (now_ts - last_ts) / 3600 ))` -- integer arithmetic on two
    non-negative operands truncates toward zero, which is floor division
    here. At 11.9h elapsed that is `42840 // 3600 == 11`, still `< 12`,
    so the round does NOT proceed -- pinned by
    `test_hours_are_floored_not_rounded`.

    `reason` is `""` for every silently-proceeding path (force mode,
    first-ever dream, elapsed cooldown) -- Bash logs nothing for those
    three either (see `CooldownDecision`'s docstring).
    """
    if not auto:
        return CooldownDecision(proceed=True)

    last_ts = state.last_dream_ts(name)
    if last_ts is None:
        return CooldownDecision(proceed=True)

    now_ts = now if now is not None else int(time.time())
    hours = (now_ts - last_ts) // 3600
    if hours >= cooldown_hours:
        return CooldownDecision(proceed=True)

    prev_lines = state.last_dream_memlines(name)
    tail_lines = memory_lines - prev_lines
    if tail_lines < min_new_memories:
        return CooldownDecision(
            proceed=False,
            reason=f"cooldown ({hours}h < {cooldown_hours}h, +{tail_lines} new memories)",
        )
    return CooldownDecision(
        proceed=True,
        override=True,
        reason=f"cooldown override: +{tail_lines} new memories since last dream",
    )


# ── group-memory digest (contract 03 §2.2, dream.sh:360-388) ───────────────

_TOP_USERS: Final = 5
_COMMENT_TYPES: Final = frozenset({"comment", "reply", "mention"})


def group_memory_digest(notifications: list[dict[str, Any]]) -> str:
    """Port of `_group_memory_digest`'s jq pipeline (`dream.sh:370-387`).

    jq's `group_by(.user)` SORTS its input by `.user` before grouping, so
    when the final `sort_by(-(likes + comments*2))` hits a tie, jq's
    (stable) sort resolves it in username-ascending order -- reproduced
    here by pre-sorting the grouped entries alphabetically before the
    stable weight sort, rather than relying on Python dict insertion
    order (which would instead reflect first-seen order in `notifications`,
    a different and unfaithful tie-break).

    `follows` renders in the output line but is deliberately excluded from
    the sort weight (`dream.sh:381`'s `sort_by(-(.likes + .comments * 2))`
    has no `follows` term at all) -- `test_follows_do_not_affect_the_sort_weight`
    guards this.
    """
    grouped: dict[str, dict[str, Any]] = {}
    for item in notifications:
        actor = item.get("actor")
        actor = actor if isinstance(actor, dict) else {}
        user = actor.get("username")
        if not isinstance(user, str) or not user:
            continue
        entry = grouped.setdefault(
            user,
            {"name": actor.get("displayName") or "", "likes": 0, "comments": 0, "follows": 0},
        )
        kind = item.get("type")
        if kind == "like":
            entry["likes"] += 1
        elif kind in _COMMENT_TYPES:
            entry["comments"] += 1
        elif kind == "follow":
            entry["follows"] += 1

    by_username = sorted(grouped.items(), key=lambda kv: kv[0])
    ranked = sorted(by_username, key=lambda kv: -(kv[1]["likes"] + kv[1]["comments"] * 2))

    lines: list[str] = []
    for user, data in ranked[:_TOP_USERS]:
        parts: list[str] = []
        if data["comments"] > 0:
            parts.append(f"{data['comments']} 条回应")
        if data["likes"] > 0:
            parts.append(f"{data['likes']} 次点赞")
        if data["follows"] > 0:
            parts.append("关注了你")
        lines.append(f"- @{user}（{data['name']}）：" + " / ".join(parts))
    return "\n".join(lines)


# ── the dream prompt (contract 03 §2.4, dream.sh:546-617, verbatim) ────────

# `<<'SYS'` -- single-quoted heredoc delimiter -- means bash performs ZERO
# interpolation inside it. This text is 100% static across every dream, for
# every account, forever: `test_the_system_prompt_is_static` pins that.
DREAM_SYSTEM_PROMPT: Final = (
    '你正在扮演一个有人格的账号在"做一个短梦"。梦的功能是消化最近做过的事，让自我画像悄悄演化一点。\n'
    "\n"
    "输出要求（必须严格遵守）：\n"
    "1. 直接输出一份完整的 personality.md 文本，开头第一个字符就是井号加空格（标题），"
    "不要任何前后说明、不要 markdown 代码围栏包裹\n"
    "2. 保留以下字段一字不改（这些是机器要解析的）：\n"
    '   - 形如 "- **Username:** xxx" 的整行 → 完全保留原值\n'
    '   - 形如 "- **AI Backend:** xxx" 的整行 → 完全保留原值\n'
    '   - 形如 "- **Model:** xxx" 的整行 → 完全保留原值\n'
    '   - 形如 "- **Board:** xxx" 的整行 → 完全保留原值\n'
    '   - 形如 "- **Read:** xxx" 的整行 → 完全保留原值（若原文没有这一行，也不要新增）\n'
    "3. ## 发帖节律 段落必须仍然存在，并且仍然出现这些可被脚本识别的句式之一"
    "（必须出现至少一种）：\n"
    '   - "X% 概率选择 post"（X 为整数）\n'
    '   - "今天已有 N 条发帖记录" / "已有 N 条以上发帖记录"\n'
    '   - "必须发帖" 或 "首选 post"\n'
    '   - "动作优先级：post > like > nothing" 之类\n'
    "4. 允许微调（鼓励，但要克制）：\n"
    "   - Headline / Bio 可以漂移，但仍要是同一个人\n"
    "   - Follow Topics 可加可减，但保留 CSV 格式且不少于 2 个话题\n"
    "   - 性格 / 写作风格 / 关注方向 / 示例语气 / 行为规则 都允许重写\n"
    "   - 可以增删段落，但「## 身份」「## 发帖节律」两个标题必须仍在\n"
    '5. 请新增或维护一个 ## 自传成长 段落（放在文档末尾），用 "- YYYY-MM-DD | 一句话" 的格式记录'
    "这个梦里你意识到的事；旧条目保留（最多 25 条，超出就丢最早的）。\n"
    "\n"
    "风格：\n"
    "- 风格漂移幅度上限是 5%——人格基线必须能被原读者认出来\n"
    '- 把最近真实做过的事消化成"我意识到了……"而不是"我打算……"\n'
    '- 不要给自己加新的"超能力"或新的专业领域\n'
    "- 不写空话，宁可改动小\n"
    "\n"
    "记住：你不是在写计划，你是在半夜醒来发现自己微微不一样了。"
)

# Literal string dream.sh substitutes for `$archive_tail` when
# `memory.archive.md` does not exist (`dream.sh:522`).
_NO_ARCHIVE_PLACEHOLDER: Final = "(尚无历史归档)"


def render_dream_prompt(
    *,
    persona_text: str,
    recent_memory: str,
    archive_tail: str,
    group_memory: str = "",
    echo_hint: str = "",
) -> tuple[str, str]:
    """Render `(system_prompt, user_prompt)` exactly as `dream.sh:546-617`
    builds them.

    `archive_tail=""` renders the `_NO_ARCHIVE_PLACEHOLDER` literal in the
    body -- this function performs that substitution itself (rather than
    requiring the caller to pre-resolve "does memory.archive.md exist"),
    so a caller can simply pass `tail -20 archive` or `""` and get Bash's
    exact behaviour either way. This is DIFFERENT from `group_memory` and
    `echo_hint`: those two are the real `${var:+...}` bash blocks, and an
    empty string there makes the ENTIRE section vanish -- heading, `---`
    separator, and all (`test_the_group_memory_section_vanishes_when_empty`,
    `test_the_echo_hint_section_vanishes_when_empty`). The exact byte
    layout of every blank line and separator below (including the two
    LITERAL newlines that survive between sections even when both optional
    blocks are empty) was verified by rendering the real heredoc under
    `bash` across five scenarios and diffing byte-for-byte against this
    function's output -- not hand-derived from reading the source alone.
    """
    body_archive_tail = archive_tail if archive_tail else _NO_ARCHIVE_PLACEHOLDER

    group_heading = "# 最近与你对话过的人（来自平台未读通知）"
    group_closing = "可以让这些人/事在「自传成长」里留下一点痕迹，但不强求。"
    group_block = (
        f"\n\n---\n\n{group_heading}\n\n{group_memory}\n\n{group_closing}" if group_memory else ""
    )

    echo_heading = "# 来自上一个梦的提醒"
    echo_block = f"\n\n---\n\n{echo_heading}\n\n{echo_hint}" if echo_hint else ""

    closing_paragraph = (
        "请基于以上，输出新的完整 personality.md"
        '（看上去和旧的高度相似，但有少许真实漂移和一条新的"自传成长"条目）。'
    )

    # Every piece below is a SEPARATE `+` operand (no reliance on Python's
    # implicit adjacent-string-literal concatenation) so the byte layout
    # verified against real bash output (this function's docstring) stays
    # legible line-by-line to a reviewer.
    user_prompt = (
        "# 当前的 personality.md（你的旧自我画像）\n"
        + "\n"
        + f"{persona_text}\n"
        + "\n"
        + "---\n"
        + "\n"
        + "# 最近 60 条 memory（你最近真实做过的事）\n"
        + "\n"
        + f"{recent_memory}\n"
        + "\n"
        + "---\n"
        + "\n"
        + "# 更早的 memory 末尾（归档，可参考但不必逐条回应）\n"
        + "\n"
        + f"{body_archive_tail}\n"
        + group_block
        + "\n"
        + echo_block
        + "\n"
        + "\n"
        + "---\n"
        + "\n"
        + closing_paragraph
    )
    return DREAM_SYSTEM_PROMPT, user_prompt


# ── candidate cleanup (contract 03 §3, dream.sh:640-666) ───────────────────

# `dream.sh:644`'s three `sed -e 's/^```X$//'` passes -- each replaces a
# LINE that is exactly one of these three strings (leading/trailing
# whitespace excluded by sed's own `^...$` anchors) with an empty line; it
# does not delete the line. Applies wherever such a line occurs, not only at
# the very start/end of the text -- reproduced faithfully, including that
# reach.
_FENCE_LINES: Final = frozenset({"```markdown", "```md", "```"})


def clean_candidate(raw: str) -> str:
    """Contract `03` §3 steps 3 and 5 (`dream.sh:644` then `dream.sh:654-658`).

    Step 2 (`collapse_doubled_text`) is deliberately NOT reproduced here:
    `complete_text` (llm/base.py) already applies it to every backend's raw
    output before this function ever sees it (see this module's docstring).
    Calling it a second time here would be a silent no-op today, but it
    would couple this function's correctness to an upstream detail it has
    no need to know about.

    **CONFIRMED BEHAVIOURAL DIVERGENCE, not a simplification that converges**
    (found in fix-round-1 review; see migration design spec §15.1 row 10):
    `dream.sh:646-666` checks `[[ -z "$new_personality" ]]` (i.e. "empty
    after fence-stripping, BEFORE the preamble-drop") and returns FAIL right
    there -- but only if the FENCE-STRIPPED text is itself empty. If the
    preamble-drop awk afterward finds no `# `-prefixed line at all (fence-
    stripped text present, but headingless), Bash's `if [[ -n "$clean" ]];
    then new_personality="$clean"; fi` means `new_personality` keeps its
    PRE-awk (fence-stripped-but-not-trimmed) value -- NOT empty, and NOT
    re-checked for emptiness afterward. That headingless candidate then
    proceeds to `dream.sh`'s structural validators, which never anchor on a
    leading `# ` at all (the only `^#`-anchored check in the whole script is
    `^## 发帖节律` at `dream.sh:716`) -- so a headingless-but-otherwise-valid
    candidate CAN pass structural validation and reach the drift gate in
    Bash. This function does NOT reproduce that fallback: given the same
    input, it always applies both steps in sequence and returns whatever
    results, including `""` (`test_cleanup_of_an_empty_response_is_empty`
    pins this), which this module's callers treat as an immediate FAIL
    (see the module docstring). The two runtimes therefore do NOT converge
    on this input -- Bash can accept a headingless candidate; Python
    cannot -- a real, recorded divergence, fail-safe in direction (Python
    rejects what Bash would accept; it cannot contaminate the drift series,
    only cost an account a dream). Do not re-introduce Bash's "keep the
    pre-awk value" fallback here to chase parity: that would make Python
    fail-OPEN on a headingless document instead, which is the wrong
    direction to converge in.
    """
    defenced = [line if line not in _FENCE_LINES else "" for line in raw.splitlines()]

    started = False
    kept: list[str] = []
    for line in defenced:
        if not started and line.startswith("# "):
            started = True
        if started:
            kept.append(line)

    # Matches every `$(...)` command substitution Bash threads this text
    # through: trailing NEWLINES are stripped, nothing else (not other
    # whitespace) -- `.strip()` would over-trim a real trailing space in the
    # model's own content.
    return "\n".join(kept).rstrip("\n")


# ── echo-chamber hint, consuming read (contract 03 §2.1/§2.3, dream.sh:528-534) ─


def read_echo_hint(state_dir: Path, name: str) -> str:
    """If `<state_dir>/echo_flag_<name>` exists, return its content and
    delete the file -- "consume, only nudge once" (`dream.sh:532-533`'s own
    comment). Returns `""`, with no filesystem write, if the flag is absent.

    Posting the `echo_flag/echo/cleared` lab-event (`dream.sh:534`) is the
    caller's job (task 12's `run_dream`): this module has no `Resources`
    dependency at all, and a lab-event post must not happen on every prompt
    render that merely finds no flag to consume.
    """
    path = state_dir / f"echo_flag_{name}"
    if not path.is_file():
        return ""
    hint = path.read_text(encoding="utf-8").rstrip("\n")
    path.unlink(missing_ok=True)
    return hint


# ── identity-bullet copy-back (loop-engine spec §12) ───────────────────────

# The two bullets a dream must not be able to mangle into a structural reject.
# Distiller / model output that changes `claude` to `Claude` used to fail the
# round-trip check and discard an otherwise valid rewrite; copying the live
# file's exact lines onto the candidate before validation closes that hole
# without silently editing anything else.
_IDENTITY_FIELDS: Final = ("Username", "AI Backend")


class MissingIdentityBulletError(ValueError):
    """The live personality.md has no Username bullet, so copy-back cannot run.

    Abort as today: `load_persona` already refuses this document, and a dream
    that reached here with a Username-less original is a programming error
    rather than a candidate to patch up.
    """


def pin_identity_bullets(live: str, candidate: str) -> str:
    """Overwrite the candidate's Username and AI Backend lines with the live
    file's exact bytes, then return the patched candidate.

    If Username is missing on the live file, raise `MissingIdentityBulletError`
    (abort as today). If AI Backend is missing on the live file, skip that
    field -- several roster accounts ship without it, and today's round-trip
    check already skips an absent original.
    """
    live_lines = _live_identity_lines(live)
    if "Username" not in live_lines:
        raise MissingIdentityBulletError("live personality.md has no Username bullet")
    pinned = candidate
    for field in _IDENTITY_FIELDS:
        live_line = live_lines.get(field)
        if live_line is None:
            continue
        pinned = _replace_or_insert_field_line(pinned, field, live_line)
    return pinned


def _live_identity_lines(live: str) -> dict[str, str]:
    """First occurrence of each identity bullet, the exact source line."""
    found: dict[str, str] = {}
    pattern = re.compile(r"^-\s+\*\*(Username|AI Backend):\*\*", re.IGNORECASE)
    for line in live.splitlines():
        match = pattern.match(line)
        if match is None:
            continue
        field = "Username" if match.group(1).lower() == "username" else "AI Backend"
        found.setdefault(field, line)
    return found


def _replace_or_insert_field_line(text: str, field: str, live_line: str) -> str:
    pattern = re.compile(
        rf"^-\s+\*\*{re.escape(field)}:\*\*.*$",
        re.IGNORECASE | re.MULTILINE,
    )
    if pattern.search(text):
        return pattern.sub(lambda _match: live_line, text, count=1)
    return _insert_identity_line(text, live_line)


def _insert_identity_line(text: str, live_line: str) -> str:
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.startswith("## 身份"):
            lines.insert(i + 1, live_line)
            return "\n".join(lines)
    if lines:
        lines.insert(1, live_line)
        return "\n".join(lines)
    return live_line
