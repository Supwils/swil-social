"""The model-neutral aspect distiller and the anchor aspect cache.

Ports `dream.sh`'s `_distill_aspects` and `_anchor_aspects` (contract `04` §3;
source of truth is `agent/scripts/dream.sh:250-341`, read directly rather than
the contract doc, since the docs have already been caught transcribing this
script wrong more than once).

Two invariants carried over from Bash, both easy to break and expensive to:

1. The JSON key `_distill_aspects` requires is `topic`, SINGULAR -- even
   though the prompt's own instructions tell the model to produce `TOPICS`
   (plural, all-caps, alongside `VALUES` and `STYLE`). That mismatch is
   baked into the prompt text itself and every downstream consumer (the
   anchor cache, the gate, `snapshot.sh`'s payload) reads the singular key.
   "Fixing" it to `topics` here breaks the JSON contract, not repairs it.
2. The anchor cache (`<dir>/personality.anchor.aspects.json`) is warm and
   live for all 23 real accounts. Its key is `sha256(anchor_text):v{N}` --
   changing that derivation, the `:v{N}` salt, or the on-disk `{key, cards,
   vectors}` shape invalidates every one of those 23 caches at once and
   forces a full roster re-distill (3 `claude` calls + 3 `/embed` calls per
   account) on the very next round. `test_the_real_zenith_cache_loads_without_redistilling`
   in `tests/unit/test_distill.py` pins the key derivation against a captured
   copy of zenith's real cache for exactly this reason.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import re
from pathlib import Path
from typing import Final, Protocol

from pydantic import ValidationError

from swil_agent.dream.drift import resolve_anchor_text
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.llm.base import BackendUnavailableError, CompletionRequest, Runner
from swil_agent.llm.neutral import distill_neutral
from swil_agent.models import AspectCards, AspectVectors

_ASPECT_KEYS: Final = ("values", "style", "topic")
_DISTILL_ATTEMPTS: Final = 3
_CACHE_FILENAME: Final = "personality.anchor.aspects.json"

# Verbatim from `dream.sh:263-267` (the `sys='...'` heredoc), byte for byte --
# including the `TOPICS` (prompt instructions) / `topic` (required JSON key)
# mismatch. This text IS what `ASPECT_PROMPT_VERSION=2` names: change a
# single character without bumping that version and cards distilled under
# the old and new wording end up mixed into one similarity series.
DISTILL_SYSTEM_PROMPT: Final = (
    "你是一个人格分析器。把给定的人物设定拆成三个维度，每个维度输出 4-8 个核心关键词或短语"
    "（不是句子），按重要性排序，用中文逗号分隔：\n"
    "VALUES = 它相信/在乎什么、价值取向、立场；\n"
    "STYLE = 它怎么说话：语气、句式、节奏、用词习惯；\n"
    "TOPICS = 它谈论的主题领域。\n"
    "用最能代表该人设的稳定词汇，避免临场发挥的修辞。只输出一个 JSON 对象："
    '{"values":"词1，词2，…","style":"…","topic":"…"}，不要解释、代码块或前后缀。'
)


class Embedder(Protocol):
    """Structural shape `anchor_aspects` needs from an embedder.

    `swil_agent.embedder.client.EmbedderClient` satisfies this for real;
    tests substitute `tests/unit/_runners.py`'s `FakeEmbedder`. A Protocol
    here (rather than typing `embedder` as `EmbedderClient | None`) is what
    lets the fake be a plain duck-typed double instead of a subclass, the
    same way `Runner` lets `ScriptedRunner` stand in for `SubprocessRunner`.
    """

    def embed(self, texts: list[str]) -> list[list[float]]: ...


def distill_cards(
    runner: Runner, text: str, *, model: str, attempts: int = _DISTILL_ATTEMPTS
) -> AspectCards | None:
    """Distil a personality document into three keyword cards.

    Dispatches through `llm/neutral.py`, which reaches real Anthropic directly
    and has ZERO imports from the backend registry (design spec §6.5). Routing
    this through the agent's own `Backend` would let a DeepSeek account be
    measured, and graded, by DeepSeek -- destroying cross-roster comparability.
    `tests/unit/test_architecture.py` enforces that unreachability; this
    function does nothing to weaken it, since it only ever imports
    `distill_neutral` itself.

    `distill_neutral` RAISES `BackendUnavailableError` on empty output rather
    than returning `""` (R3) -- caught here PER ATTEMPT so a dead distiller
    (bad auth, CLI missing, …) consumes one of its three tries instead of the
    exception escaping the loop entirely. Returns `None` after `attempts`
    failures of ANY kind (unavailable ruler, or a parseable-but-invalid
    response) -- never raises -- because the gate's fail-open path (contract
    `04` §5) depends on that `None`, not on an exception reaching it.

    A parse failure is: no `{...}` substring in the output, unparseable JSON,
    a missing key, or any of `values`/`style`/`topic` not a non-empty string
    after stripping (contract `04` §3).
    """
    request = CompletionRequest(system=DISTILL_SYSTEM_PROMPT, user=f"【人物设定】\n{text}")
    for _ in range(attempts):
        try:
            raw = distill_neutral(request, runner, model)
        except BackendUnavailableError:
            continue
        parsed = _parse_cards(raw)
        if parsed is not None:
            return parsed
    return None


def _parse_cards(raw: str) -> AspectCards | None:
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if match is None:
        return None
    try:
        obj = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    # NOTE: the key is `topic`, SINGULAR, while the prompt's own instructions
    # say TOPICS. That mismatch is deliberate and every consumer depends on it
    # (contract 04 §3, module docstring above). Do not "correct" it to
    # `topics` -- that breaks the JSON contract every downstream reader
    # (anchor cache, gate, snapshot.sh) already relies on.
    values = {k: obj.get(k) for k in _ASPECT_KEYS}
    if any(not isinstance(v, str) or not v.strip() for v in values.values()):
        return None
    return AspectCards.model_validate(values)


def anchor_cache_key(text: str, *, prompt_version: str) -> str:
    """`sha256(text):v{prompt_version}` -- matches `dream.sh:309-318`'s
    `hash="$(printf '%s' "$anchor_text" | sha256sum | awk '{print $1}')"` /
    `key="${hash}:v${ASPECT_PROMPT_VERSION}"` exactly. Pinned against a real
    captured cache in `tests/unit/test_distill.py`; a drift here silently
    invalidates all 23 warm on-disk caches at once (module docstring)."""
    return f"{hashlib.sha256(text.encode()).hexdigest()}:v{prompt_version}"


def anchor_aspects(
    directory: Path,
    *,
    runner: Runner,
    embedder: Embedder | None,
    model: str,
    prompt_version: str,
) -> AspectVectors | None:
    """Compute-or-load an account's anchor aspect vectors (`dream.sh:304-341`).

    Read path: if `<directory>/personality.anchor.aspects.json` exists and its
    `.key` equals the freshly computed key, return `.vectors` -- no distiller
    call, no embed call. Any mismatch (different anchor text, a bumped
    `prompt_version`, a missing/corrupt file) is a cache miss.

    Write path on a miss: distil the anchor text, then embed each of the
    three cards INDIVIDUALLY (three separate `/embed` calls, contract `04`
    §3 -- `values`, then `style`, then `topic`, matching `dream.sh:332-334`'s
    call order). Only if all three embeds succeed is `{key, cards, vectors}`
    written to disk -- there is no "2 of 3 aspects cached" state. The write
    itself is best-effort (`dream.sh:339`'s `|| true`): a disk failure means
    re-distilling next time, not a failed dream now.

    `embedder=None` is only meaningful for a proven cache HIT -- a genuine
    miss has nowhere to send the three `/embed` calls and raises `ValueError`
    rather than silently returning `None` (which would be indistinguishable
    from "the distiller failed").
    """
    anchor_text = resolve_anchor_text(directory)
    key = anchor_cache_key(anchor_text, prompt_version=prompt_version)
    cache_file = directory / _CACHE_FILENAME

    cached = _read_cache(cache_file, key)
    if cached is not None:
        return cached

    cards = distill_cards(runner, anchor_text, model=model)
    if cards is None:
        return None

    if embedder is None:
        raise ValueError(
            "anchor_aspects: cache miss but no embedder was given -- an "
            "embedder is required to build a fresh anchor cache"
        )

    vectors = _embed_cards(cards, embedder)
    if vectors is None:
        return None

    _persist_cache(cache_file, key=key, cards=cards, vectors=vectors)
    return vectors


def _read_cache(cache_file: Path, key: str) -> AspectVectors | None:
    if not cache_file.is_file():
        return None
    try:
        payload = json.loads(cache_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("key") != key:
        return None
    vectors = payload.get("vectors")
    if not isinstance(vectors, dict):
        return None
    try:
        return AspectVectors.model_validate(vectors)
    except ValidationError:
        return None


def _embed_cards(cards: AspectCards, embedder: Embedder) -> AspectVectors | None:
    """Three separate `/embed` calls, one per card, in `values, style, topic`
    order -- matching `dream.sh:332-334`'s `_embed_text` calls exactly. A
    single batched call would change what ends up cached and drop this out of
    lockstep with the 23 caches already on disk, each written one card at a
    time. Any embed failure aborts before the remaining calls -- no partial
    result is ever assembled, let alone cached."""
    try:
        values = embedder.embed([cards.values])[0]
        style = embedder.embed([cards.style])[0]
        topic = embedder.embed([cards.topic])[0]
    except EmbedderUnavailable:
        return None
    return AspectVectors(values=values, style=style, topic=topic)


def _persist_cache(
    cache_file: Path, *, key: str, cards: AspectCards, vectors: AspectVectors
) -> None:
    """Best-effort write, matching `dream.sh:339`'s `|| true`: a disk failure
    here is silently swallowed and simply means the anchor gets re-distilled
    and re-embedded on the next dream, not that this one fails."""
    payload = {
        "key": key,
        "cards": cards.model_dump(),
        "vectors": vectors.model_dump(),
    }
    with contextlib.suppress(OSError):
        cache_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
