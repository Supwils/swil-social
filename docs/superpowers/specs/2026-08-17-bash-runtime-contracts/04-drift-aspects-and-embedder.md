# Behavioural contract — dream.sh drift/aspect machinery + embedder server.py

Source files (read in full):
- `agent/scripts/dream.sh` (956 lines)
- `agent/scripts/embedder/server.py` (277 lines)

All line references below are `dream.sh:N` or `server.py:N` against these exact files as of this read.

---

## 1. Embedder HTTP API (server.py)

FastAPI app, `lifespan` loads `BAAI/bge-m3` (or `$EMBEDDER_MODEL`) once at startup on device
`$EMBEDDER_DEVICE` (`auto|mps|cpu|cuda`, auto-detect order mps → cuda → cpu, `server.py:64-76`).
Warms the model once (`model.encode(["warmup"])`, `server.py:143`) before serving.

### GET /health  (`server.py:187-196`)

No request body. Always 200. Response:

```json
{
  "ok": true,
  "model": "BAAI/bge-m3",
  "device": "mps",
  "dim": 1024,
  "max_seq_length": 8192,
  "batch_size": 4
}
```

`device`/`dim`/`max_seq_length` come straight from `_state` (populated at startup); if hit before
`lifespan` finishes these keys are simply absent/`None` rather than erroring — there is no
"loading" flag, `health` doesn't check readiness at all (contrast with `/embed`, which does).

### POST /embed  (`server.py:199-277`)

Request body — Pydantic `EmbedReq` (`server.py:166-171`):
```json
{ "texts": ["string", "..."], "allow_empty": false }
```
- `texts`: required, `min_length=1, max_length=64` (a request with 0 or >64 items is a 422 from
  Pydantic validation, before the handler body runs).
- `allow_empty`: optional, default `false`. If any text is blank/whitespace-only and
  `allow_empty` is false → `422 "blank text in input (set allow_empty=true to override)"`
  (`server.py:207-208`, raised via `HTTPException`).

Response body — `EmbedResp` (`server.py:174-184`):
```json
{
  "model": "BAAI/bge-m3",
  "device": "mps",
  "dim": 1024,
  "embeddings": [[0.0123, -0.0456, "...1024 floats..."]],
  "cache_hits": 1,
  "cache_misses": 0,
  "truncated": 0
}
```
`embeddings[i]` corresponds to `texts[i]` — order preserved via
`embeddings = [_blob_to_vec(found[sha], dim) for sha in shas]` (`server.py:268`), so cache hits
and freshly-computed misses are transparently interleaved back into request order.

Error shapes:
- `503 "embedder not initialised"` — model/cache/dim not ready yet (`server.py:204-205`). Can
  only happen if `/embed` is hit during/before `lifespan` startup.
- `422 "blank text in input (set allow_empty=true to override)"` — see above (`server.py:207-208`).
- Pydantic's own 422 for `texts` length violations (0 items or >64 items), not custom-raised.

Vectors are **L2-normalized** (`normalize_embeddings=True` in the `model.encode(...)` call,
`server.py:250`) — this is why `dream.sh`'s cosine-similarity helper can just take a dot product
(see §4).

### Cache (`cache.sqlite`)

SQLite file at `HERE/cache.sqlite` (sibling of `server.py`, `server.py:47-48`), opened once at
startup (`_init_cache`, `server.py:110-119`), closed on shutdown (`server.py:158-160`).
Schema:
```sql
CREATE TABLE IF NOT EXISTS embeddings (
    sha TEXT PRIMARY KEY,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL
)
```
- Key = `sha256(text.encode("utf-8")).hexdigest()` (`server.py:210`) — content-addressed, no TTL,
  no eviction. Same text (byte-identical after UTF-8 encoding) → same key forever.
- Batch lookup via `SELECT sha, vec FROM embeddings WHERE sha IN (?,?,...)` (`server.py:212-216`),
  guarded by `_cache_lock` (a plain `threading.Lock`, only ever guards SQLite ops — comment
  explicitly warns it does **not** guard the model itself, `server.py:60`).
- Misses are embedded in one `model.encode()` call (`server.py:247-253`) guarded by a **separate**
  `_model_lock` that serializes the forward pass across concurrent requests — added after a
  2026-08-13 incident where 5 concurrent `cycle-one.sh` processes calling `/embed` at once drove
  the daemon to 27.8 GB unified memory, pushed the machine into swap, and made `dream.sh`'s 8s
  health probe (`_group_memory_digest` etc.) time out, which fail-opened the drift gate for three
  dreams (`server.py:53-61`).
- New vectors are written with `INSERT OR REPLACE INTO embeddings(sha, dim, vec) VALUES (?,?,?)`
  via `executemany` (`server.py:257-263`), then merged into the in-memory `found` dict so the
  final assembly loop reads uniformly regardless of hit/miss (`server.py:264-266`).
- Vector encoding in the BLOB: raw `float32` little-endian bytes, no length prefix inside the
  blob — `dim` is a separate column and is used to `struct.unpack(f"<{dim}f", blob)` on read
  (`server.py:122-129`).

### Truncation

`truncated` in the response counts, over **every text in the request** (not just cache misses —
comment `server.py:222-225` explains why: a cached vector was built from an equally-clipped input,
so scoping to misses would make the field's meaning depend on whether the call happened to be a
cache hit). For each text, token count is taken via the model's own tokenizer
(`model.tokenizer.encode(text, add_special_tokens=True, truncation=False)`, `server.py:101-107`,
returns `-1` on any tokenizer failure, which then never exceeds `max_seq` so is silently treated
as "not truncated"). If `n > max_seq_length`, `truncated` increments and a loud `print(...)` WARN
is emitted server-side (`server.py:229-241`) — this is a log line only, **not** surfaced per-text
in the JSON response (the response only has an aggregate count, no way to tell *which* text(s)
were clipped).

`MAX_SEQ_LEN` env (`EMBEDDER_MAX_SEQ_LEN`) defaults to `0` = "whatever the model config declares"
(8192 for bge-m3) and is deliberately never lowered by default, because the drift experiment
compares cosine similarities across snapshots recorded over months and shortening the window
would silently change the measuring instrument mid-experiment (`server.py:36-45`).

### Batch size / device cache

`BATCH_SIZE` (`EMBEDDER_BATCH_SIZE`) defaults to 4 — a sub-batch used inside `model.encode(...,
batch_size=BATCH_SIZE)`, deliberately far below sentence-transformers' default of 32 to bound
worst-case activation memory for an 8192-token-window XLM-RoBERTa-large model (`server.py:30-34`).
After every forward pass, `_release_device_cache` calls `torch.mps.empty_cache()` /
`torch.cuda.empty_cache()` to hand freed blocks back to the OS, since PyTorch's caching allocator
never shrinks on its own and the process would otherwise look like it leaks memory
(`server.py:79-98`, called at `server.py:144` on warmup and `server.py:254` after every `/embed`
forward pass).

---

## 2. Anchor resolution (`_anchor_text_for`, `dream.sh:220-247`)

Priority, in order:

1. **`<dir>/personality.anchor.md`** — if this file exists, `cat` it verbatim and return
   (`dream.sh:228-231`). This is an explicit pin overriding the archive entirely. Confirmed live
   in the repo: `agent/agents/quant/personality.anchor.md` exists (188 lines) and is quant's
   permanent anchor regardless of how many dreams accumulate in its archive.

2. **Oldest block of `<dir>/personality.archive.md`**, if that file exists (`dream.sh:232-244`).
   Exact extraction logic (this is the real Python heredoc, `dream.sh:234-243`):
   ```python
   import re, sys
   text = open(sys.argv[1], encoding='utf-8').read()
   matches = list(re.finditer(r'^---\s*\n# 旧版 personality（归档于 [\d\- :]+）\s*\n---\s*\n', text, re.MULTILINE))
   if matches:
       last = matches[-1]
       print(text[last.end():].strip())
   else:
       print(text.strip())
   ```
   The archive file is **newest-first**: every accepted dream *prepends* a new stamped block
   (header + the personality.md being replaced) ahead of the existing archive contents
   (`dream.sh:834-847`):
   ```bash
   {
     echo "---"
     echo "# 旧版 personality（归档于 ${stamp}）"
     echo "---"
     cat "$pfile"
     echo
     [[ -f "$old_arch" ]] && cat "$old_arch"
   } > "${old_arch}.tmp" && mv "${old_arch}.tmp" "$old_arch"
   ```
   So the physically **last** regex match in the file is the **chronologically oldest** archived
   version — hence `matches[-1]`, and everything after its header (`text[last.end():]`) up to EOF
   is that oldest block's full personality.md body. Verified against real data
   (`agent/agents/zenith/personality.archive.md`, 3468 lines): the final header in the file is
   `# 旧版 personality（归档于 2026-05-24 18:48:45）`, and the text from there to EOF is a complete,
   well-formed `# 玄思` personality document — matches the code path exactly.
   If the archive file exists but contains **no** matching header (malformed/legacy format), the
   `else` branch returns `text.strip()` — the entire archive file content as-is.

3. **No anchor pin, no archive file at all** — fall back to `cat "$dir/personality.md"`
   (`dream.sh:246`), i.e. the *current* personality is its own anchor. This is the documented
   first-dream case (comment `dream.sh:223`): the very first dream for a fresh account always
   scores drift against itself, so `scalar_sim` will be ≈1.0 and the aspect sims will be
   ≈1.0-ish too (candidate vs. itself, pre-any-drift).

Note on ordering vs. the archive-write step: the gate reads `anchor_text` at `dream.sh:739`
*before* this dream's archive-prepend happens at `dream.sh:834-847` (which only runs after the
gate already accepted). So the anchor used to score a given dream is always "whatever the anchor
was before this dream," never contaminated by the dream currently being scored — no
self-referential leak.

This function is also reused inside `_anchor_aspects` (`dream.sh:307-341`) purely to build the
cache key (see §3) — same resolution logic, same priority order, called again (not memoized
across the two call sites within one `dream_one` run).

---

## 3. Aspect distillation (`_distill_aspects`, `dream.sh:260-302`)

### Full prompt, verbatim

System prompt (`dream.sh:263-267`):
```
你是一个人格分析器。把给定的人物设定拆成三个维度，每个维度输出 4-8 个核心关键词或短语（不是句子），按重要性排序，用中文逗号分隔：
VALUES = 它相信/在乎什么、价值取向、立场；
STYLE = 它怎么说话：语气、句式、节奏、用词习惯；
TOPICS = 它谈论的主题领域。
用最能代表该人设的稳定词汇，避免临场发挥的修辞。只输出一个 JSON 对象：{"values":"词1，词2，…","style":"…","topic":"…"}，不要解释、代码块或前后缀。
```

User prompt (`dream.sh:268`, built via `printf`):
```
【人物设定】
<text>
```
where `<text>` is the full personality document being distilled (either the anchor text or the
dream candidate text — same distiller function, same prompt, called from both `_anchor_aspects`
line 330 and the gate at line 755).

### The 3 aspects and output format

Aspect names in the *prompt's instructions*: `VALUES`, `STYLE`, `TOPICS` (plural, all-caps).
Aspect names in the *required JSON keys*: `values`, `style`, `topic` (singular "topic", not
"topics" — a deliberate mismatch baked into the prompt itself at `dream.sh:267`; every downstream
consumer — `_anchor_aspects`, the gate, `_aspect_breached`, `snapshot.sh`'s payload — uses the
singular `topic` key consistently, so this is a naming quirk, not a bug, but worth knowing if
reimplementing: don't "fix" it to `topics` or the JSON contract breaks).

Each value is a single string: 4–8 keyword/short-phrase items, ranked by importance, joined by
Chinese full-width commas (`，`) — explicitly **not prose sentences** (comment `dream.sh:255-259`
notes cards are "CANONICAL KEYWORD LISTS, not prose" — this format choice was made because prose
cards made the `values` dimension the noisiest under an earlier format).

### Dispatch, retries, failure definition

```bash
out="$(printf '%s' "$usr" | claude --model "$ASPECT_DISTILL_MODEL" -p --system-prompt "$sys" --output-format text 2>/dev/null || true)"
```
(`dream.sh:275`) — called **directly**, bypassing `llm.sh` entirely (an explicit, commented
invariant at `dream.sh:270-274`: this must stay the same model regardless of the agent's own
`AI Backend` bullet, or per-aspect drift numbers stop being comparable across the roster — "A
deepseek account must not be measured by deepseek").

`ASPECT_DISTILL_MODEL` env, default `"haiku"` (`dream.sh:68`) — i.e. real Anthropic Claude Haiku
via the `claude` CLI's `--model` flag, not routed through DeepSeek's Anthropic-compatible endpoint
or `codex`.

Retries: up to 3 attempts (`for attempt in 1 2 3`, `dream.sh:269`). Each attempt independently
calls the CLI and parses the result via a Python heredoc that takes the raw output as `argv[1]`
(explicitly *not* piped — comment `dream.sh:276-278` notes piping would collide with the heredoc
program reading its own stdin):
```python
import sys, json, re
raw = sys.argv[1] if len(sys.argv) > 1 else ""
out = ""
m = re.search(r'\{.*\}', raw, re.DOTALL)
if m:
    try:
        obj = json.loads(m.group(0))
        keys = ("values", "style", "topic")
        if all(k in obj and isinstance(obj[k], str) and obj[k].strip() for k in keys):
            out = json.dumps({k: obj[k] for k in keys}, ensure_ascii=False)
    except Exception:
        pass
print(out)
```
(`dream.sh:279-294`). A **failed distill attempt** = either the regex finds no `{...}` block, or
`json.loads` throws, or the parsed object is missing any of `values`/`style`/`topic`, or any of
those three is not a non-empty (post-strip) string. On any of these, `parsed=""` and the loop
tries again; if `parsed` is non-empty the function returns it immediately (`dream.sh:295-298`).
After **all 3 attempts fail**, the function echoes `""` and returns 0 (`dream.sh:300-301`) — note
it *always* returns exit code 0 even on total failure (the empty-string return value is the only
failure signal; callers check `[[ -z "$cards" ]]` etc., not `$?`).

### Anchor aspect cache (`personality.anchor.aspects.json`, `_anchor_aspects`, `dream.sh:304-341`)

File: `<dir>/personality.anchor.aspects.json`. **Not currently present for any account in the
repo** (checked `agent/agents/*` and `agent/humans/*` — no such file exists yet; it is created
lazily on first `DRIFT_MODE != scalar` dream for an account). Shape, reconstructed exactly from
the write code at `dream.sh:336-339`:

```json
{
  "key": "<sha256-hex-of-anchor-text>:v2",
  "cards": {
    "values": "求真，独立判断，长期主义，反对信息噪音，……",
    "style": "简洁，反问句，克制的讽刺，短句为主，……",
    "topic": "AI，哲学，语言模型，认知边界，……"
  },
  "vectors": {
    "values": [0.0123, -0.0456, "...1024 floats..."],
    "style": [0.0987, 0.0021, "...1024 floats..."],
    "topic": [-0.0033, 0.0456, "...1024 floats..."]
  }
}
```
(`values`/`style`/`topic` strings above are illustrative, matching the format contract, not a
literal captured example, since no such file exists in the repo currently.)

Cache key: `sha256(anchor_text):v${ASPECT_PROMPT_VERSION}` (`dream.sh:309-318`) —
`ASPECT_PROMPT_VERSION` env defaults to `"2"` (`dream.sh:66`); bump it whenever the distiller
prompt text changes so stale cards under the old prompt wording get invalidated
(comment `dream.sh:258`).

Read path (`dream.sh:319-327`): if the cache file exists, read `.key`; if it matches the freshly
computed key, read `.vectors` and return them if non-empty. Any mismatch (different anchor text,
or `ASPECT_PROMPT_VERSION` bumped) is a cache miss.

Write path on cache miss (`dream.sh:328-340`): distill the anchor text into `cards`; if that's
empty, return `""` (no cache write). Otherwise embed each of `cards.values` / `cards.style` /
`cards.topic` **individually** via `_embed_text` (3 separate `/embed` calls, `dream.sh:332-334`);
if **any** of the 3 embeds is empty, return `""` — **no partial cache is ever written** (there's
no "2 of 3 aspects cached" state). Only if all three succeed does it assemble `vectors` and write
the full `{key, cards, vectors}` object to disk via `jq -n ... > "$cache_file"` — this write is
best-effort (`|| true`, `dream.sh:339`): a disk-write failure is silently swallowed and simply
means the anchor gets re-distilled + re-embedded (3 more `claude` calls + 3 more `/embed` calls)
on the next dream.

---

## 4. Similarity computation — verbatim heredocs

### `_cosine_sim` (`dream.sh:118-136`)

```python
import json, sys, math
try:
    a = json.loads(sys.argv[1])
    b = json.loads(sys.argv[2])
    if not a or not b or len(a) != len(b):
        print(1.0); sys.exit(0)
    dot = sum(x*y for x, y in zip(a, b))
    # bge-m3 returns L2-normalised vectors so the dot product is already cosine.
    # Clamp for floating-point noise.
    print(max(-1.0, min(1.0, dot)))
except Exception:
    print(1.0)
```
Invoked as `python3 - "$1" "$2" <<'PY' ... PY || echo "1.0"` (`dream.sh:122`) — i.e. the two
vectors are passed as JSON-array-string **argv**, not piped.

Inputs: two JSON arrays of floats (as raw strings) representing two embedding vectors.
Output (stdout): a single float, the cosine similarity — computed as a raw dot product (valid
because bge-m3 outputs are pre-normalized by the embedder's `normalize_embeddings=True`), clamped
to `[-1.0, 1.0]`.

**Fail-open by design**: any malformed/empty/mismatched-length input, or any exception at all
(including the outer bash `|| echo "1.0"` if the python interpreter itself errors), yields `1.0`
— i.e. "perfectly similar," which means a broken embed call never by itself causes a *rejection*
via this function; it can only cause the *caller* to notice the embed was empty (callers check
`[[ -n "$anchor_vec" && -n "$cand_vec" ]]` before ever invoking this) and fall into the "embedder
unreachable" WARN path instead. This function itself never distinguishes "genuinely identical"
from "computation failed."

### `_aspect_breached` (`dream.sh:343-356`)

```python
import sys, json
v, st, tp, tv, tst, ttp = map(float, sys.argv[1:7])
br = []
if v < tv: br.append("values")
if st < tst: br.append("style")
if tp < ttp: br.append("topic")
print(json.dumps(br))
```
Invoked as:
```bash
_aspect_breached() {
  python3 - "$1" "$2" "$3" \
    "$DRIFT_THRESHOLD_VALUES" "$DRIFT_THRESHOLD_STYLE" "$DRIFT_THRESHOLD_TOPIC" <<'PY' 2>/dev/null || echo '[]'
```
Inputs: `$1 $2 $3` = the three computed similarities (values_sim, style_sim, topic_sim, in that
positional order), `$4 $5 $6` = the three configured thresholds in the same order (values, style,
topic — bound from `DRIFT_THRESHOLD_VALUES`/`_STYLE`/`_TOPIC`, `dream.sh:346-347`).
Output: a JSON array of the aspect names (strings) whose similarity fell **strictly below** its
own threshold — may be `[]` if nothing breached. Fail path (bad args / python error): stderr
suppressed, stdout falls through to bash's `|| echo '[]'` (i.e. "nothing breached" on failure —
also fail-open, though this path is only reached if the caller already validated all 6 args are
non-empty numeric strings, since `dream.sh:764-767` only calls this after confirming all three
candidate-side embeds succeeded).

### `_pairwise_variance` (`dream.sh:192-218`, echo-detection only)

```python
import json, sys
data = open(sys.argv[1], encoding='utf-8').read().strip()
if not data:
    print(1.0); sys.exit(0)
try:
    vecs = json.loads(data)
    vecs = [v for v in vecs if isinstance(v, list) and v]
    if len(vecs) < 3:
        print(1.0); sys.exit(0)
    sims = []
    for i in range(len(vecs)):
        for j in range(i+1, len(vecs)):
            a, b = vecs[i], vecs[j]
            if len(a) != len(b): continue
            sims.append(sum(x*y for x, y in zip(a, b)))
    if not sims:
        print(1.0); sys.exit(0)
    mean = sum(sims) / len(sims)
    var = sum((s - mean) ** 2 for s in sims) / len(sims)
    print(var)
except Exception:
    print(1.0)
```
Invoked as `python3 - "$vec_file" <<'PY' ... PY || echo "1.0"` (`dream.sh:194`) — **crucially
takes the vectors as a file path argv, never via stdin/pipe**. The inline comment
(`dream.sh:142-155`) documents why this matters: the *original* signature piped the vectors on
stdin into a script invoked as `python3 - <<'PY'`, which binds the heredoc itself to python's
stdin, so `sys.stdin.read()` inside the script returned `''` — every call silently fell through to
the `1.0` fallback (so `1.0 < ECHO_VARIANCE_THRESHOLD(0.04)` was never true — echo detection never
fired for any account, ever), *and* nothing ever drained the pipe, so once an account's payload
(12 posts × 1024 dims ≈ 172 KB) exceeded the 64 KB pipe buffer, the writer died of `SIGPIPE`
(exit 141) right after the "snapshot uploaded" log line — before the `RETURN` trap could clear
`dream_lock_<name>`, orphaning the lock. This is the historical bug behind the "Accepted-dream
SIGPIPE orphan lock" issue; the file-path argv convention fixes both problems simultaneously.

Inputs: a file containing a JSON array of embedding-vector arrays (`[[...],[...],...]`), read from
`sys.argv[1]`. Filters out non-list/empty entries. Requires **≥3** valid vectors, else falls back
to `1.0`. Computes all pairwise dot products (cosine sims, since vectors are pre-normalized) among
valid same-length pairs, then variance = `mean((sim - mean_sim)^2)` over all pairwise sims.
Output: a single float — low variance + high mean sim = "this account's recent posts are all
saying the same thing" (echo-chamber signal). Fail-open here too: any parse error, empty file,
or `<3` vectors → `1.0` (a high "variance" value that will never trip the low-variance
`< threshold` echo check — i.e. failure reads as "not an echo chamber," never a false positive).

---

## 5. The gate (`dream.sh:732-826`)

### `DRIFT_MODE` env, default `"scalar"` (`dream.sh:62`)

- `scalar` — legacy single cosine-similarity gate. No aspect computation happens at all (the
  `if [[ "$DRIFT_MODE" != "scalar" ]]` block at `dream.sh:752` is skipped entirely).
- `shadow` — aspect sims **are** computed and logged (a `SHADOW-OBS` line per dream, see below),
  but the actual accept/reject decision still uses the **scalar** gate. Pure observability, for
  threshold calibration.
- `aspect` — the per-aspect thresholds decide accept/reject: **any single breach rejects the whole
  dream** (`dream.sh:786-795`), *provided* the aspect computation actually succeeded
  (`aspect_ok == 1`); if aspect distill/embed failed, `aspect` mode silently falls back to the
  scalar gate for that one dream (see fail-open paths below).

  Per CLAUDE.md, the live `agent/.env` sets `DRIFT_MODE=aspect` — but the *script's own default*
  if `DRIFT_MODE` is unset is `scalar` (`dream.sh:62`). Worth flagging for the Python port: which
  default to bake in depends on whether the port also sources `agent/.env`, or is meant to match
  the bash script's bare default.

### Threshold env vars and defaults

| var | default | scope |
|---|---|---|
| `DRIFT_THRESHOLD` | `0.82` | scalar gate (min cosine sim anchor↔candidate) — `dream.sh:52` |
| `DRIFT_THRESHOLD_VALUES` | `0.63` | aspect gate, values dimension — `dream.sh:63` |
| `DRIFT_THRESHOLD_STYLE` | `0.72` | aspect gate, style dimension — `dream.sh:64` |
| `DRIFT_THRESHOLD_TOPIC` | `0.71` | aspect gate, topic dimension — `dream.sh:65` |
| `ASPECT_PROMPT_VERSION` | `2` | cache-key salt for anchor aspect cache — `dream.sh:66` |
| `ASPECT_DISTILL_MODEL` | `haiku` | neutral distiller model — `dream.sh:68` |

All thresholds are lower bounds on **similarity** (not distance) — a candidate whose sim is
`< threshold` is treated as "drifted too far." Comment block `dream.sh:57-61` documents these
per-aspect numbers came from a 17-observation shadow-mode calibration round on 2026-07-03: the
original design hypothesis ("guard `values` strictest") was refuted — keyword-card distillation
puts all three dimensions on roughly the same ~0.70 band, with `values` actually the *lowest* (not
highest) of the three, hence the thresholds are symmetric rather than values-favoring, and were
tuned to accept ~29% of dreams (≈ matching the legacy scalar gate's strictness).

### "Breached" (aspect mode)

Computed by `_aspect_breached` (§4): an aspect's similarity strictly below **its own** configured
threshold is added to the `breached` array. The gate rejects if `breached` is non-empty for
**any** of the three dimensions (`dream.sh:787`: `if [[ "$(... | jq -r '.breached | length')" != "0" ]]`).
There is no partial-credit / majority-vote — one breach is enough.

### Decision flow, in order (`dream.sh:784-820`)

1. Whole-doc scalar embed is always attempted first (`dream.sh:742-749`), independent of
   `DRIFT_MODE` — its result (`scalar_sim`, `scalar_drift = round(1 - sim, 4)`) is used by scalar
   mode, shadow mode, and as the aspect-mode fallback.
2. If `DRIFT_MODE != scalar`, aspect sims are also computed (`dream.sh:752-776`): distill+embed
   the anchor (via cache, `_anchor_aspects`) and the candidate (`_distill_aspects` fresh, no
   cache for the candidate side — only the anchor side is cached), embed each of the candidate's
   3 cards, compute the 3 cosine sims, run `_aspect_breached`, and set `aspect_ok=1` only if
   *both* anchor_aspects and cand_cards were non-empty *and* all 3 candidate embeds succeeded.
   If `aspect_ok` stays `0`: `_log "WARN $name — aspect distill/embed failed, falling back to scalar drift"` (`dream.sh:775`).
3. If `DRIFT_MODE == shadow` and aspect data was produced, log a `SHADOW-OBS` line **regardless of
   the eventual accept/reject outcome** (`dream.sh:780-782`) — so calibration data accumulates
   from both accepted and rejected dreams, not just the survivors:
   ```
   _log "SHADOW-OBS $name pv=<ASPECT_PROMPT_VERSION> values=<v> style=<s> topic=<t> breached=<[...]>"
   ```
4. Final decision (`dream.sh:785-807`):
   - `DRIFT_MODE == aspect && aspect_ok == 1` → gate = aspect breach check (step above).
   - Otherwise (scalar mode, shadow mode, or aspect mode with a failed aspect computation) → gate
     = scalar: reject if `scalar_sim < DRIFT_THRESHOLD`, computed via
     `python3 -c "import sys; sys.exit(0 if float('$scalar_sim') < float('$DRIFT_THRESHOLD') else 1)"`
     (exit 0 = condition true = reject).
     - If `scalar_sim` itself was never set (anchor or candidate embed failed) → this branch's
       `else` fires: `_log "WARN $name — embedder unreachable, skipping drift check"`
       (`dream.sh:804`) + `_post_agent_event ... "warn" ... "embedder unreachable, skipped drift check"`
       (`dream.sh:805`) — `reject` stays `0`, dream proceeds unvetted.

### Fail-open paths, exact log lines

| condition | log line | effect |
|---|---|---|
| embedder unreachable for the scalar-level embed (anchor or candidate `_embed_text` returns empty) | `WARN $name — embedder unreachable, skipping drift check` (`dream.sh:804`) | drift check entirely skipped; dream accepted regardless of true drift |
| aspect distill/embed fails in `shadow`/`aspect` mode | `WARN $name — aspect distill/embed failed, falling back to scalar drift` (`dream.sh:775`) | falls through to the scalar gate (which may itself fail-open per the row above) |
| no anchor at all | — not a real fail-open path — `_anchor_text_for` always returns *something* (falls back to `personality.md` itself, `dream.sh:246`); `dream_one` already `SKIP`s at `dream.sh:456` before the gate runs if `personality.md` is missing, so the gate never sees a truly empty anchor |
| candidate fails structural validation (Username/AI Backend/Model/Board/Read drift, missing required fields, missing rhythm section, <2 Follow Topics) | assorted `FAIL $name — ...` lines (`dream.sh:676`–`727`) | **happens before the drift gate is even reached** — these are hard rejects independent of `DRIFT_MODE`, not fail-opens |

On accept, one of two success log lines fires depending on which gate decided it
(`dream.sh:822-826`):
```
$name — aspect drift OK (values=<v> style=<s> topic=<t>)         # aspect mode, aspect_ok==1
$name — drift OK (sim=<scalar_sim>, drift=<scalar_drift>)        # everything else
```
Note: in `shadow` mode, this final "drift OK" line only ever shows the *scalar* numbers — the
per-aspect numbers for that same dream only appear earlier via the `SHADOW-OBS` line, not here.

On reject (`dream.sh:809-820`):
```
FAIL $name — $reject_reason; keeping original
```
where `reject_reason` is either
`"aspect drift: [<breached list>] breached (values=<v>, style=<s>, topic=<t>)"` or
`"drift too large (sim=<scalar_sim>, threshold=<DRIFT_THRESHOLD>)"`. An agent event is posted with
a `metrics` payload of either `{aspects:{values,style,topic}, breached, mode}` or
`{similarity, drift}`. The candidate file is deleted, `dream_one` returns — **the original
`personality.md`, `last_dream_marker`, and `last_dream_memlines_<name>` are all left untouched**,
meaning a rejected dream does **not** reset the cooldown timer (next cooldown check still measures
from the *previous* accepted dream, `dream.sh:480-509`).

---

## 6. Echo detection (`dream.sh:884-931`)

**OFF by default**: gated on `ECHO_DETECT` env, default `"0"` (`dream.sh:75`), checked as
`if [[ "${ECHO_DETECT:-0}" == "1" && -f "$key_file" ]]` (`dream.sh:900`). Only runs **after** a
dream has already been accepted, archived, written, and snapshotted (it's the last block inside
`dream_one`, after the `snapshot.sh` call) — a rejected dream never reaches this code at all.

### Fetch (last 12 posts)

```bash
curl -sS --max-time 10 \
  -H "Authorization: Bearer $(cat "$key_file")" \
  "$SWIL_URL/api/v1/users/$username/posts?limit=12"
```
(`dream.sh:905-908`), where `username` is re-read from the (now-updated) `personality.md`'s
`Username` bullet. Texts extracted via
`jq -r '[.data.items[]?.text // empty | select(length > 0)]'` (`dream.sh:908`) — i.e. up to 12
non-empty post bodies, in whatever order the API returns them (not necessarily embedding-order
guaranteed beyond that). If the result is `"[]"` or empty, the whole block is skipped silently (no
WARN log for "not enough posts").

### Variance computation

The 12 (or fewer) texts are embedded in one `/embed` call
(`{texts: recent_texts}` POST to `$EMBEDDER_URL/embed`, `dream.sh:910-914`), the `.embeddings`
array is written to a temp file, and `_pairwise_variance` (§4) is run against that file path.
Requires ≥3 valid vectors to produce a real number; otherwise the `1.0` fallback applies (never
trips the echo check).

### Threshold and effect

`ECHO_VARIANCE_THRESHOLD` env, default `0.04` (`dream.sh:76`) — explicitly documented as
**never calibrated against real data**: measured pairwise variance across 6 real accounts' bge-m3
embeddings is `0.00098`–`0.01138`, an order of magnitude below `0.04`, so turning this on as-is
would flag essentially every account on every dream (`dream.sh:69-71`, restated in the large
comment block at `dream.sh:889-898`). This is *why* it stays off — enabling it would inject a
"switch topic/stance" nudge into nearly every dream prompt, confounding the topic-aspect
measurement that the in-flight drift experiment depends on.

If `variance < ECHO_VARIANCE_THRESHOLD`:
```
_log "$name — echo chamber detected (variance=$variance < $ECHO_VARIANCE_THRESHOLD); flagging"
```
(`dream.sh:923`), and a nudge message is written to `$STATE_DIR/echo_flag_${name}`
(`dream.sh:924-925`):
```
你最近 12 条帖子的话题/语气相似度过高（pairwise variance = $variance）。下个梦在「自传成长」里写一条关于换入口、换主题、换姿态的觉悟。
```
plus an agent event `echo_flag`/`echo`/`flagged` with `{variance}` in its metrics
(`dream.sh:926`).

### Where the nudge lands

Consumed at the **start of the next** `dream_one` call for that account (`dream.sh:529-535`):
if `echo_flag_<name>` exists, its content is read into `echo_hint`, the file is immediately
deleted (consumed exactly once — a second dream before another echo flag is set gets no hint),
and an agent event `echo_flag`/`echo`/`cleared` is posted. `echo_hint` is then interpolated into
that dream's **generation prompt** (not the gate) under a `# 来自上一个梦的提醒` section
(`dream.sh:605-611`), nudging the LLM to write an "自传成长" entry about switching input/topic/
posture. It has **zero effect on the drift gate itself** — it's purely a prompt-injection into the
next dream's free-text generation, and structurally it's just one more `## 自传成长` bullet like
any other, so it must still pass the same structural + drift checks as everything else in that
next candidate.

---

## Ambiguities / self-contradictions worth flagging for the port

- `DRIFT_MODE` script default (`scalar`, `dream.sh:62`) vs. CLAUDE.md's claim that `aspect` is
  "the live default" — true only because `agent/.env` overrides it; the bash script's own
  fallback, if `agent/.env` is absent or the var unset, is `scalar`. A Python port needs to decide
  which behavior it's replicating.
- The distiller prompt's human-facing dimension name is `TOPICS` (plural) but the required JSON
  key is `topic` (singular) — intentional in the source, easy to "fix" incorrectly in a rewrite.
- `_aspect_breached`'s own fail path (`|| echo '[]'`) is unreachable in practice as currently
  called (the caller only invokes it once all 3 sims are already confirmed non-empty numeric
  strings at `dream.sh:764-767`), so its fail-open behavior is dead code today, not a live path.
- No `personality.anchor.aspects.json` currently exists anywhere in the repo — the JSON shape in
  §3 is derived from the write code, not captured from a live file.
