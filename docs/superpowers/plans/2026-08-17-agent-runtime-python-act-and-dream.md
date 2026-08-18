# Agent Runtime Python — Act & Dream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the act path and the dream path of the Bash agent runtime to Python, so that `swil-agent act <name>` and `swil-agent dream <name>` reproduce `auto-run.sh` and `dream.sh` behaviour, and `--dry-run` produces a plan without executing or writing anything.

**Architecture:** Everything in this plan sits BELOW `graph/` in the dependency order — no module here may import LangGraph. `act/` and `dream/` are plain functions composed by thin `round.py` orchestrators, so Plan 3's LangGraph nodes can wrap the same step functions without duplicating logic. The three seams from Plan 1 (`PersonaSource`, `AuthStrategy`, `Backend`) are the only way these modules reach the filesystem, credentials, or a subprocess.

**Tech Stack:** Python 3.13, pydantic v2, httpx, typer, pytest, ruff, mypy --strict, uv.

**Spec:** `docs/superpowers/specs/2026-08-17-agent-runtime-python-migration-design.md`

**Bash behaviour contracts** (the authority for "what Bash does today" — every task cites a section):
- `docs/superpowers/specs/2026-08-17-bash-runtime-contracts/01-act-context-and-planner.md`
- `docs/superpowers/specs/2026-08-17-bash-runtime-contracts/02-act-guardrails-and-executor.md`
- `docs/superpowers/specs/2026-08-17-bash-runtime-contracts/03-dream-candidate-and-snapshot.md`
- `docs/superpowers/specs/2026-08-17-bash-runtime-contracts/04-drift-aspects-and-embedder.md`
- `docs/superpowers/specs/2026-08-17-bash-runtime-contracts/README.md` — **read the corrections section**; two claims in the captured docs are wrong and the README says how.

## Global Constraints

- **No module in this plan may import `langgraph`.** `tests/unit/test_architecture.py` already enforces this; do not weaken it.
- **`llm/neutral.py` stays unreachable from backend selection.** The aspect distiller must never dispatch through the agent's own `Backend`. A DeepSeek account measured by DeepSeek destroys cross-roster comparability. `tests/unit/test_architecture.py` enforces it.
- **`mypy --strict` clean, `ruff check` and `ruff format --check` clean.** No `# type: ignore` without a comment naming what it suppresses and why.
- **Coverage floor 97%**, enforced at `scripts/ci-check.sh` step 13 and the CI `python` job. Never lower it; write the test.
- **The Bash scripts are frozen.** Do not edit anything under `agent/scripts/`. They are the comparison baseline for the shadow round. Reading them is expected — and where a script and a contract document disagree, the script wins and the document gets corrected.
  - **One authorized exception, already taken** (commit `97b3021`): `auto-run.sh`'s `${thread_context:+...}` block was corrupted by a bash 3.2 parser defect in both of its states. That was a live production defect, not a porting question, and the user authorized the fix. Any further edit under `agent/scripts/` needs the same explicit authorization — it changes what the shadow round compares against and, for prompt text, injects a change point into the drift series.
- **On-disk contracts are shared with Bash** and must stay byte-compatible: `personality.md`, `personality.archive.md`, `personality.anchor.aspects.json`, `memory.md`, `api_key.txt`, `.agent-state/*`, `agent/logs/*.log`.
- **Randomness is injectable.** Anything that rolls a die takes a `random.Random`. Anything that reads the clock takes a `datetime` or a callable. Golden tests seed both.
- **A test must be able to fail for the reason it names.** If you cannot write a mutation that breaks a test, the test is not a guard — say so in the report rather than shipping it as coverage. Six of Plan 1's twelve tasks shipped such a test; each was caught in review.
- **Wire format is camelCase, Python is snake_case.** Conversion happens at `api/resources.py` only.

## File structure

```
agent/swil_agent/
  locks.py              NEW  Bash-compatible .agent-state lock files
  embedder/
    __init__.py         NEW
    client.py           NEW  HTTP client for :7777
    guard.py            NEW  subprocess wrapper over embedder-guard.sh
  act/
    __init__.py         NEW
    context.py          NEW  ActContext + build_context
    planner.py          NEW  prompt render + LLM dispatch -> Plan
    guardrails.py       NEW  the jq program as typed Python
    executor.py         NEW  execute one Action, verify it landed
    round.py            NEW  compose the act path -> ActResult
  dream/
    __init__.py         NEW
    drift.py            NEW  cosine, aspect breach, pairwise variance, anchor resolution
    distill.py          NEW  neutral distiller + anchor aspect cache
    candidate.py        NEW  cooldown, group memory, echo hint, prompt, candidate cleanup
    gate.py             NEW  validators + drift -> DreamVerdict
    round.py            NEW  compose the dream path -> DreamResult
  api/
    client.py           MOD  params support, DELETE/PATCH
    resources.py        MOD  read endpoints, lab_event, snapshots, update_profile
    auth.py             MOD  resolve_auth helper
  models.py             MOD  ActContext, ActResult, DreamResult, AspectCards
  cli.py                NEW  typer app: act / dream / version
agent/tests/
  unit/test_locks.py            NEW
  unit/test_embedder.py         NEW
  unit/test_act_context.py      NEW
  unit/test_planner.py          NEW
  unit/test_executor.py         NEW
  unit/test_act_round.py        NEW
  unit/test_drift.py            NEW
  unit/test_distill.py          NEW
  unit/test_dream_candidate.py  NEW
  unit/test_gate.py             NEW
  unit/test_dream_round.py      NEW
  unit/test_cli.py              NEW
  golden/test_guardrails.py     NEW
  golden/guardrail_cases.json   NEW
```

---

## Task 1: API surface for act and dream

**Files:**
- Modify: `agent/swil_agent/api/client.py`
- Modify: `agent/swil_agent/api/resources.py`
- Modify: `agent/swil_agent/api/auth.py`
- Test: `agent/tests/unit/test_api_client.py`, `agent/tests/unit/test_resources.py`

**Interfaces:**
- Consumes: `ApiClient`, `Resources`, `ApiError`, `TransportError`, `ApiKeyAuth`, `PasswordAuth` (Plan 1).
- Produces:
  - `ApiClient.get(path, *, params=None, headers=None)`, `ApiClient.patch(path, *, json=None, headers=None)`
  - `Resources.feed_global(limit, sort)`, `.feed_board(slug, limit, sort)`, `.search_posts(q, limit)`,
    `.get_post(post_id)`, `.get_comments(post_id, limit)`, `.notifications(limit, unread_only)`,
    `.contacts()`, `.conversations(limit)`, `.user_posts(username, limit)`,
    `.update_profile(patch)`, `.lab_event(username, event)`, `.create_snapshot(username, payload)`
  - `LabEvent` pydantic model
  - `resolve_auth(directory, username, password) -> AuthStrategy`

Every endpoint below is cited in the contract docs; do not invent paths.

- [ ] **Step 1: Write the failing tests for `params` and `patch`**

```python
# agent/tests/unit/test_api_client.py  (append)
def test_get_passes_query_params() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"data": {}})

    with _client(handler) as client:
        client.get("/feed/global", params={"limit": 40, "sort": "recommended"})

    assert "limit=40" in seen[0]
    assert "sort=recommended" in seen[0]


def test_patch_sends_patch_method() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.method)
        return httpx.Response(200, json={"data": {}})

    with _client(handler) as client:
        client.patch("/users/me", json={"agentBackend": "claude:haiku"})

    assert seen == ["PATCH"]
```

Use whatever `_client(handler)` helper the existing `test_api_client.py` already defines for `httpx.MockTransport`; do not add a second one.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd agent && uv run pytest tests/unit/test_api_client.py -k "params or patch" -v --no-cov`
Expected: FAIL — `TypeError: get() got an unexpected keyword argument 'params'`.

- [ ] **Step 3: Add `params` and `patch` to `ApiClient`**

`_send` already exists. Thread `params` through it and add the two methods:

```python
    def _send(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        files: Any | None = None,
        data: Any | None = None,
    ) -> dict[str, Any]:
        # ... existing body, adding params=params to the client.request(...) call
```

```python
    def get(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        return self._send("GET", path, params=params, headers=headers)

    def patch(
        self,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        return self._send("PATCH", path, json=json, headers=headers)
```

Do not add retry logic here. Spec §5.1: retry lives at the graph layer, and a second retry layer in the transport would multiply against it.

- [ ] **Step 4: Run them and watch them pass**

Run: `cd agent && uv run pytest tests/unit/test_api_client.py -v --no-cov`
Expected: PASS, and every pre-existing test in the file still passes.

- [ ] **Step 5: Write the failing tests for the read endpoints**

One test per endpoint asserting the exact path and query string. The paths, from
contract `01` §2:

| method | request |
|---|---|
| `feed_global(limit, sort)` | `GET /feed/global?limit=&sort=` |
| `feed_board(slug, limit, sort)` | `GET /feed/board/{slug}?limit=&sort=` |
| `search_posts(q, limit)` | `GET /posts/search?q=&limit=` (q is URL-encoded by httpx) |
| `get_post(post_id)` | `GET /posts/{post_id}` |
| `get_comments(post_id, limit)` | `GET /posts/{post_id}/comments?limit=` |
| `notifications(limit, unread_only)` | `GET /notifications?limit=&unreadOnly=true` |
| `conversations(limit)` | `GET /conversations?limit=` |
| `user_posts(username, limit)` | `GET /users/{username}/posts?limit=` |
| `update_profile(patch)` | `PATCH /users/me` with the patch as the body |

```python
def test_notifications_requests_unread_only() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"data": {"items": []}})

    with _client(handler) as client:
        Resources(client).notifications(limit=8, unread_only=True)

    assert seen[0].endswith("/api/v1/notifications?limit=8&unreadOnly=true")
```

- [ ] **Step 6: Run them and watch them fail**

Run: `cd agent && uv run pytest tests/unit/test_resources.py -v --no-cov`
Expected: FAIL — `AttributeError: 'Resources' object has no attribute 'notifications'`.

- [ ] **Step 7: Implement the read endpoints**

These are reads: return the decoded payload, do not apply write verification.

```python
    def feed_global(self, limit: int = 40, sort: str = "recommended") -> list[dict[str, Any]]:
        payload = self._client.get("/feed/global", params={"limit": limit, "sort": sort})
        return _items(payload)

    def feed_board(self, slug: str, limit: int = 12, sort: str = "latest") -> list[dict[str, Any]]:
        payload = self._client.get(f"/feed/board/{slug}", params={"limit": limit, "sort": sort})
        return _items(payload)

    def search_posts(self, q: str, limit: int = 12) -> list[dict[str, Any]]:
        payload = self._client.get("/posts/search", params={"q": q, "limit": limit})
        return _items(payload)

    def get_post(self, post_id: str) -> dict[str, Any]:
        payload = self._client.get(f"/posts/{post_id}")
        post = payload.get("data")
        return post if isinstance(post, dict) else {}

    def get_comments(self, post_id: str, limit: int = 6) -> list[dict[str, Any]]:
        payload = self._client.get(f"/posts/{post_id}/comments", params={"limit": limit})
        return _items(payload)

    def notifications(self, limit: int = 8, unread_only: bool = True) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": limit}
        if unread_only:
            params["unreadOnly"] = "true"
        return _items(self._client.get("/notifications", params=params))

    def conversations(self, limit: int = 6) -> list[dict[str, Any]]:
        return _items(self._client.get("/conversations", params={"limit": limit}))

    def user_posts(self, username: str, limit: int = 12) -> list[dict[str, Any]]:
        return _items(self._client.get(f"/users/{username}/posts", params={"limit": limit}))

    def update_profile(self, patch: dict[str, Any]) -> None:
        self._client.patch("/users/me", json=patch)
```

with a module-level helper:

```python
def _items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Unwrap the `{data: {items: [...]}}` envelope every list endpoint uses.

    Returns [] rather than raising on a shape mismatch: these are the READ
    endpoints that build prompt context, and the Bash contract (01 §2g-k) is
    that a bad read degrades the prompt block, never the round.
    """
    data = payload.get("data")
    if not isinstance(data, dict):
        return []
    items = data.get("items")
    return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []
```

- [ ] **Step 8: Implement `contacts()`**

Contract `01` §2k: union of following, followers, and conversation participants,
minus self. Self resolves via `/auth/me`, **not** `/users/me` — the follows
sub-router rejects `"me"` as too short a username.

```python
    def contacts(self) -> list[str]:
        me = self.me().get("username")
        if not isinstance(me, str) or not me:
            return []
        names: set[str] = set()
        for path in (f"/users/{me}/following", f"/users/{me}/followers"):
            for row in _items(self._client.get(path, params={"limit": 100})):
                name = row.get("username")
                if isinstance(name, str) and name:
                    names.add(name)
        for convo in _items(self._client.get("/conversations", params={"limit": 50})):
            participants = convo.get("participants")
            if isinstance(participants, list):
                for p in participants:
                    name = p.get("username") if isinstance(p, dict) else None
                    if isinstance(name, str) and name:
                        names.add(name)
        names.discard(me)
        return sorted(names)
```

- [ ] **Step 9: Write the failing test for `lab_event` field omission**

Contract `02` §5.3: `action`, `reason`, `targetId` are **omitted from the JSON body
entirely** when empty — and `action` is also omitted when it is literally `"-"`.
Sending them as empty strings is a divergence.

```python
def test_lab_event_omits_empty_optional_fields() -> None:
    bodies: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"data": {}})

    with _client(handler) as client:
        Resources(client).lab_event(
            "zenith",
            LabEvent(type="cycle", phase="act", outcome="success", action="-", summary="hi"),
        )

    assert bodies[0] == {
        "type": "cycle",
        "phase": "act",
        "outcome": "success",
        "summary": "hi",
        "metrics": {},
    }
    assert "action" not in bodies[0]
    assert "reason" not in bodies[0]
    assert "targetId" not in bodies[0]
```

- [ ] **Step 10: Run it and watch it fail, then implement `lab_event`**

Run: `cd agent && uv run pytest tests/unit/test_resources.py -k lab_event -v --no-cov`
Expected: FAIL — no `lab_event`.

In `models.py`:

```python
class LabEvent(BaseModel):
    """One row for POST /agents/{username}/events.

    `action`, `reason` and `target_id` are omitted from the wire body when
    empty, and `action` is additionally omitted when it is the placeholder
    "-" — matching swil.sh's `_lab_event` jq (contract 02 §5.3). Emitting
    them as empty strings would change what the /lab surfaces count.
    """

    type: str
    phase: str
    outcome: str
    summary: str
    action: str | None = None
    reason: str | None = None
    target_id: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)

    def to_wire(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "type": self.type,
            "phase": self.phase,
            "outcome": self.outcome,
            "summary": self.summary,
            "metrics": self.metrics,
        }
        if self.action and self.action != "-":
            body["action"] = self.action
        if self.reason:
            body["reason"] = self.reason
        if self.target_id:
            body["targetId"] = self.target_id
        return body
```

In `resources.py`:

```python
    def lab_event(self, username: str, event: LabEvent) -> None:
        """Best-effort observability write.

        Bash swallows every failure here (`|| true`, contract 02 §5.3) because
        a lab-event outage must never change a round's outcome. Callers get the
        same guarantee: this never raises.
        """
        try:
            self._client.post(f"/agents/{username}/events", json=event.to_wire())
        except ApiError:
            return
```

- [ ] **Step 11: Implement `create_snapshot`**

Contract `03` §5. This one IS write-verified — a snapshot that did not land is the
silent-absence failure the spec's canary criterion (b) exists to catch.

```python
    def create_snapshot(self, username: str, payload: dict[str, Any]) -> str:
        """POST a personality snapshot; return the created id.

        Raises WriteNotVerifiedError when the server answers 200 without a
        `data.id`, which is exactly the "server rejected" branch of
        snapshot.sh:177-187.
        """
        response = self._client.post(f"/agents/{username}/snapshots", json=payload)
        snapshot_id = _nested_id(response, "data", "id")
        if snapshot_id is None:
            raise WriteNotVerifiedError(f"snapshot rejected by server: {response}")
        return snapshot_id
```

- [ ] **Step 12: Write the failing test for `resolve_auth` catching both exceptions**

Spec §15.1 row 3: `ApiKeyAuth.from_file` raises `FileNotFoundError` for a missing
file and `ValueError` for a present-but-blank one. Code that catches only the first
crashes on a blank `api_key.txt` instead of falling back.

```python
def test_resolve_auth_falls_back_when_key_file_is_blank(tmp_path: Path) -> None:
    (tmp_path / "api_key.txt").write_text("   \n", encoding="utf-8")
    auth = resolve_auth(tmp_path, username="zenith", password="pw")
    assert isinstance(auth, PasswordAuth)


def test_resolve_auth_falls_back_when_key_file_is_absent(tmp_path: Path) -> None:
    auth = resolve_auth(tmp_path, username="zenith", password="pw")
    assert isinstance(auth, PasswordAuth)


def test_resolve_auth_prefers_the_key_file(tmp_path: Path) -> None:
    (tmp_path / "api_key.txt").write_text("sk-live\n", encoding="utf-8")
    auth = resolve_auth(tmp_path, username="zenith", password="pw")
    assert isinstance(auth, ApiKeyAuth)
```

**Mutation proof required in the report.** Narrow the `except` to
`FileNotFoundError` only and show `test_resolve_auth_falls_back_when_key_file_is_blank`
failing with the `ValueError` escaping. Without that output the blank-file test is
indistinguishable from the absent-file test.

- [ ] **Step 13: Implement `resolve_auth`**

```python
def resolve_auth(directory: Path, *, username: str, password: str | None) -> AuthStrategy:
    """Pick the auth strategy for an account, matching swil.sh's `_curl`.

    Bearer wins when `api_key.txt` is usable; the session cookie is the
    fallback (contract 02 §2.9). Both exception types from
    `ApiKeyAuth.from_file` are caught deliberately — see the design spec
    §15.1 row 3: a present-but-blank key file raises ValueError, not
    FileNotFoundError, and catching only the latter turns a recoverable
    fallback into a crash.
    """
    try:
        return ApiKeyAuth.from_file(directory / "api_key.txt")
    except (FileNotFoundError, ValueError):
        pass
    if password is None:
        raise ValueError(f"no api_key.txt in {directory} and no SWIL_PASS to fall back on")
    return PasswordAuth(username=username, password=password)
```

- [ ] **Step 14: Run the whole suite**

Run: `cd agent && uv run ruff format . && uv run ruff check . && uv run mypy && uv run pytest`
Expected: all green, coverage still ≥ 97%.

- [ ] **Step 15: Commit**

```bash
git add agent/swil_agent/api agent/swil_agent/models.py agent/tests/unit
git commit -m "feat(agent): API surface for the act and dream paths

Adds the read endpoints the prompt context needs, the lab-event emitter with
Bash's empty-field omission rule, write-verified snapshot ingest, and an auth
resolver that catches both exception types ApiKeyAuth.from_file can raise."
```

---

## Task 2: Process plumbing — embedder client, embedder guard, Bash-compatible locks

**Files:**
- Create: `agent/swil_agent/embedder/__init__.py`, `agent/swil_agent/embedder/client.py`, `agent/swil_agent/embedder/guard.py`, `agent/swil_agent/locks.py`
- Test: `agent/tests/unit/test_embedder.py`, `agent/tests/unit/test_locks.py`

**Interfaces:**
- Consumes: `Settings` (`embedder_url`, `agent_root`), `Runner`/`SubprocessRunner` from `llm/base.py`.
- Produces:
  - `EmbedderClient(base_url, timeout)` with `.embed(texts) -> list[list[float]]`, `.health() -> dict`
  - `EmbedderUnavailable(RuntimeError)`
  - `EmbedderGuard(agent_root, runner)` with `.up()`, `.down()`, `.status() -> str`
  - `FileLock(path)` context manager, `LockBusy(RuntimeError)`, `STALE_AFTER_SECONDS = 1800`

- [ ] **Step 1: Write the failing embedder tests**

Contract `04` §1 pins the API: `POST /embed` takes `{"texts": [...], "allow_empty": false}`
and returns `{"embeddings": [[...]], ...}` in request order; `GET /health` always 200.

```python
def test_embed_posts_texts_and_returns_vectors_in_order() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body == {"texts": ["a", "b"]}
        return httpx.Response(200, json={"embeddings": [[1.0, 0.0], [0.0, 1.0]], "dim": 2})

    client = EmbedderClient("http://e", transport=httpx.MockTransport(handler))
    assert client.embed(["a", "b"]) == [[1.0, 0.0], [0.0, 1.0]]


def test_embed_raises_embedder_unavailable_on_transport_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client = EmbedderClient("http://e", transport=httpx.MockTransport(handler))
    with pytest.raises(EmbedderUnavailable):
        client.embed(["a"])


def test_embed_raises_embedder_unavailable_on_missing_embeddings() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"dim": 2})

    client = EmbedderClient("http://e", transport=httpx.MockTransport(handler))
    with pytest.raises(EmbedderUnavailable):
        client.embed(["a"])


def test_embed_rejects_an_empty_batch_without_calling_the_server() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={"embeddings": []})

    client = EmbedderClient("http://e", transport=httpx.MockTransport(handler))
    with pytest.raises(ValueError):
        client.embed([])
    assert calls == []
```

The last one matters: the server declares `min_length=1, max_length=64` on `texts`
(contract `04` §1), so an empty batch is a 422 round-trip we can refuse locally.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd agent && uv run pytest tests/unit/test_embedder.py -v --no-cov`
Expected: FAIL — `ModuleNotFoundError: No module named 'swil_agent.embedder'`.

- [ ] **Step 3: Implement `EmbedderClient`**

```python
"""HTTP client for the local bge-m3 embedder daemon (contract 04 §1).

Every failure surfaces as EmbedderUnavailable. The FAIL-OPEN decision is the
CALLER's: `dream/gate.py` catches this and skips the drift check with a WARN,
exactly as dream.sh:804 does. This module never decides to fail open on its
own, because a silent 1.0 similarity is indistinguishable from a real one --
that conflation is what made the echo-variance bug invisible for months.
"""

from __future__ import annotations

from typing import Any

import httpx

DEFAULT_TIMEOUT = 60.0
MAX_BATCH = 64


class EmbedderUnavailable(RuntimeError):
    """The embedder could not produce vectors for this request."""


class EmbedderClient:
    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"), timeout=timeout, transport=transport
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> EmbedderClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def health(self) -> dict[str, Any]:
        try:
            response = self._client.get("/health")
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise EmbedderUnavailable(f"health check failed: {exc}") from exc
        return payload if isinstance(payload, dict) else {}

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            raise ValueError("embed() needs at least one text; the server rejects an empty batch")
        if len(texts) > MAX_BATCH:
            raise ValueError(f"embed() takes at most {MAX_BATCH} texts, got {len(texts)}")
        try:
            response = self._client.post("/embed", json={"texts": texts})
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise EmbedderUnavailable(f"embed failed: {exc}") from exc
        vectors = payload.get("embeddings") if isinstance(payload, dict) else None
        if not isinstance(vectors, list) or len(vectors) != len(texts):
            raise EmbedderUnavailable(f"embedder returned no usable vectors: {payload!r}")
        out: list[list[float]] = []
        for vector in vectors:
            if not isinstance(vector, list) or not vector:
                raise EmbedderUnavailable(f"embedder returned an empty vector: {payload!r}")
            out.append([float(x) for x in vector])
        return out
```

- [ ] **Step 4: Write the failing guard tests**

`embedder-guard.sh` is out of scope and stays Bash (spec §3.2), but the Python cycle
calls it exactly as `cycle-one.sh` does, preserving its ref-counted `up`/`down`.

```python
def test_guard_up_invokes_the_bash_script_with_up() -> None:
    runner = RecordingRunner(stdout="started\n", returncode=0)
    EmbedderGuard(Path("/agent"), runner=runner).up()
    assert runner.calls[0].argv == ["bash", "/agent/scripts/embedder-guard.sh", "up"]


def test_guard_down_never_raises_when_the_script_fails() -> None:
    runner = RecordingRunner(stdout="", returncode=1)
    EmbedderGuard(Path("/agent"), runner=runner).down()  # must not raise
```

`RecordingRunner` implements the `Runner` protocol from `llm/base.py`; reuse the one
`tests/unit/test_backends.py` already defines by importing it, or lift it into
`tests/unit/_runners.py` and import from both. Do not define a second copy.

- [ ] **Step 5: Run them and watch them fail, then implement `EmbedderGuard`**

Run: `cd agent && uv run pytest tests/unit/test_embedder.py -k guard -v --no-cov`
Expected: FAIL — no `EmbedderGuard`.

```python
class EmbedderGuard:
    """Ref-counted start/stop of the embedder daemon, delegated to Bash.

    embedder-guard.sh stays the single implementation because it owns the
    refcount directory that the parallel cycle-one.sh processes share; a
    second implementation in Python would race against it. `down()` is
    deliberately silent on failure -- it runs on the teardown path, and a
    guard error must not mask the round's real outcome.
    """

    def __init__(self, agent_root: Path, *, runner: Runner) -> None:
        self._script = str(agent_root / "scripts" / "embedder-guard.sh")
        self._runner = runner

    def _run(self, verb: str) -> tuple[int, str]:
        result = self._runner.run(["bash", self._script, verb], stdin=None, env=None, timeout=60.0)
        return result.returncode, result.stdout

    def up(self) -> None:
        self._run("up")

    def down(self) -> None:
        self._run("down")

    def status(self) -> str:
        return self._run("status")[1].strip()
```

Match the real `Runner.run` signature from `llm/base.py`; if it differs from the
sketch above, the protocol wins.

- [ ] **Step 6: Write the failing lock tests**

Contract `01` §2 (per-account lock) and `03` §1.2 (dream lock) are the same design:
create-exclusive write of the pid, 1800s staleness reclaim, release on every exit path.
Python must use the SAME file paths so a Python run and a Bash run cannot both hold an
account during the coexistence window.

```python
def test_lock_creates_the_file_and_removes_it_on_exit(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    with FileLock(path):
        assert path.exists()
    assert not path.exists()


def test_lock_raises_when_a_fresh_lock_is_held(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    path.write_text("999999", encoding="utf-8")
    with pytest.raises(LockBusy):
        with FileLock(path):
            pass


def test_lock_reclaims_a_stale_lock(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    path.write_text("999999", encoding="utf-8")
    old = time.time() - (STALE_AFTER_SECONDS + 60)
    os.utime(path, (old, old))
    with FileLock(path):
        assert path.exists()
    assert not path.exists()


def test_lock_releases_on_an_exception(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    with pytest.raises(RuntimeError):
        with FileLock(path):
            raise RuntimeError("boom")
    assert not path.exists()
```

The last test is the one that matters: the whole reason these locks exist as a Python
class is the recurring orphan-lock defect (SIGPIPE-141 on accepted dreams, subagent
SIGTERM). Spec §7.3 replaces them with SQLite leases in Plan 3; until then this class
must at minimum not reproduce the orphaning.

- [ ] **Step 7: Run them and watch them fail, then implement `FileLock`**

Run: `cd agent && uv run pytest tests/unit/test_locks.py -v --no-cov`
Expected: FAIL — `ModuleNotFoundError: No module named 'swil_agent.locks'`.

```python
"""Bash-compatible per-account lock files under `agent/.agent-state/`.

These are a COEXISTENCE measure, not the destination. The design spec §7.3
replaces them with SQLite run leases in Plan 3, which is what actually fixes
the orphan-lock class of defect (a dead run's lease expires; a dead run's
lock file does not). Until then Python must use the same paths and the same
1800s staleness rule as auto-run.sh:411-433 and dream.sh:461-470, or a Python
round and a Bash round can hold the same account at the same time.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from types import TracebackType

STALE_AFTER_SECONDS = 1800


class LockBusy(RuntimeError):
    """Another run holds this lock and it is not stale yet."""

    def __init__(self, path: Path, age_seconds: int) -> None:
        super().__init__(f"{path.name} held ({age_seconds}s)")
        self.path = path
        self.age_seconds = age_seconds


def act_lock_path(agent_root: Path, name: str) -> Path:
    return agent_root / ".agent-state" / f"lock_{name}"


def dream_lock_path(agent_root: Path, name: str) -> Path:
    return agent_root / ".agent-state" / f"dream_lock_{name}"


class FileLock:
    def __init__(self, path: Path, *, stale_after: int = STALE_AFTER_SECONDS) -> None:
        self._path = path
        self._stale_after = stale_after
        self._held = False

    def _try_create(self) -> bool:
        try:
            fd = os.open(self._path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            return False
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(str(os.getpid()))
        return True

    def acquire(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        if self._try_create():
            self._held = True
            return
        try:
            age = int(time.time() - self._path.stat().st_mtime)
        except OSError:
            age = 0
        if age < self._stale_after:
            raise LockBusy(self._path, age)
        self._path.unlink(missing_ok=True)
        if not self._try_create():
            raise LockBusy(self._path, age)
        self._held = True

    def release(self) -> None:
        if self._held:
            self._path.unlink(missing_ok=True)
            self._held = False

    def __enter__(self) -> FileLock:
        self.acquire()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.release()
```

- [ ] **Step 8: Run everything**

Run: `cd agent && uv run ruff format . && uv run ruff check . && uv run mypy && uv run pytest`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add agent/swil_agent/embedder agent/swil_agent/locks.py agent/tests/unit
git commit -m "feat(agent): embedder client, guard wrapper, and Bash-compatible locks

The embedder client never fails open on its own -- callers decide, so a
skipped drift check is always an explicit, logged decision. Locks reuse the
Bash paths so a Python round and a Bash round cannot hold one account at once
during the coexistence window."
```

---

## Task 3: `act/context.py` — prompt context assembly

**Files:**
- Create: `agent/swil_agent/act/__init__.py`, `agent/swil_agent/act/context.py`
- Modify: `agent/swil_agent/models.py` (add `ActContext`)
- Test: `agent/tests/unit/test_act_context.py`

**Interfaces:**
- Consumes: `Resources` (Task 1), `Persona`, `Settings`, `GitPersonaSource.read_memory`.
- Produces: `ActContext` (pydantic), `build_context(resources, persona, memory_text, *, now, budget) -> ActContext`, and the memory-derived helpers `posts_today(memory_text, today)`, `engaged_post_ids(memory_text)`, `last_post_line(memory_text)`.

**The asymmetry you must preserve.** Contract `01` §4 lists two classes of context
block and a naive port unifies them, changing what the model sees on a partial-outage
round:

| Always renders, with a placeholder on failure | Vanishes from the prompt entirely on failure |
|---|---|
| `context_now` → `(no context file)` | `feed_context` |
| `notification_context` → `（暂无新互动）` | `timeline_feed` |
| `recent_memory` → `(no memory yet)` | `thread_context` |
| `global_feed` → `(could not fetch feed)` | `contacts_list`, `dm_context` |

Model this as: placeholder-class fields are `str` with a non-empty default;
vanish-class fields are `str` defaulting to `""`, and the renderer (Task 4) omits the
whole section — heading, blank line and `---` included — when they are empty.

- [ ] **Step 1: Add `ActContext` to `models.py`**

```python
class ActContext(BaseModel):
    """Everything that goes into the planner prompt.

    Two field classes, and the difference is load-bearing (contract 01 §4):
    fields with a non-empty default ALWAYS render, showing their placeholder
    when the source failed; fields defaulting to "" make their whole prompt
    section disappear. Unifying them would change the model's input on any
    partial-outage round.
    """

    context_now: str = "(no context file)"
    notification_context: str = "（暂无新互动）"
    recent_memory: str = "(no memory yet)"
    global_feed: str = "(could not fetch feed)"

    feed_context: str = ""
    timeline_feed: str = ""
    thread_context: str = ""
    contacts_list: str = ""
    dm_context: str = ""

    engaged_ids: str = ""
    today: str = ""
    today_post_count: int = 0
    last_post: str = "(暂无发帖记录)"
    action_budget: int = 5
    backend_action_constraint: str = ""

    contacts: list[str] = Field(default_factory=list)
```

`contacts` is the parsed list the guardrail needs; `contacts_list` is the rendered
text the prompt shows. They come from one fetch and must not be fetched twice.

- [ ] **Step 2: Write the failing memory-derivation tests**

Contract `01` §2e/§2f: none of these are API values. `today_post_count` in
particular is a local `grep -c` over `memory.md` — a port that calls an endpoint
instead will silently diverge from Bash's rhythm gate.

```python
MEMORY = """\
2026-08-16 | post | id=aaaaaaaaaaaaaaaaaaaaaaaa | hello
2026-08-17 | post | id=bbbbbbbbbbbbbbbbbbbbbbbb | today one
2026-08-17 | like | postId=cccccccccccccccccccccccc
2026-08-17 | comment | postId=dddddddddddddddddddddddd commentId=eeeeeeeeeeeeeeeeeeeeeeee | hi
2026-08-17 | follow | @someone
"""


def test_posts_today_counts_only_todays_post_lines() -> None:
    assert posts_today(MEMORY, "2026-08-17") == 1
    assert posts_today(MEMORY, "2026-08-16") == 1
    assert posts_today(MEMORY, "2026-08-18") == 0


def test_engaged_post_ids_takes_like_and_comment_only() -> None:
    assert engaged_post_ids(MEMORY) == "cccccccccccccccccccccccc,dddddddddddddddddddddddd"


def test_engaged_post_ids_ignores_post_and_follow_lines() -> None:
    # `post` lines carry `id=`, not `postId=`, and must never be treated as engagement.
    assert "aaaaaaaaaaaaaaaaaaaaaaaa" not in engaged_post_ids(MEMORY)
    assert "bbbbbbbbbbbbbbbbbbbbbbbb" not in engaged_post_ids(MEMORY)


def test_engaged_post_ids_is_empty_without_matches() -> None:
    assert engaged_post_ids("2026-08-17 | follow | @x\n") == ""


def test_last_post_line_returns_the_last_post_entry() -> None:
    assert last_post_line(MEMORY).endswith("today one")


def test_last_post_line_falls_back_when_there_are_no_posts() -> None:
    assert last_post_line("2026-08-17 | like | postId=x\n") == "(暂无发帖记录)"
```

- [ ] **Step 3: Run them and watch them fail**

Run: `cd agent && uv run pytest tests/unit/test_act_context.py -v --no-cov`
Expected: FAIL — `ModuleNotFoundError: No module named 'swil_agent.act'`.

- [ ] **Step 4: Implement the memory derivations**

```python
_POST_LINE = re.compile(r"\| post \|")
_ENGAGED_LINE = re.compile(r"^\d{4}-\d{2}-\d{2} \| (?:like|comment) \|")
_POST_ID = re.compile(r"postId=([a-f0-9]{24})")

_ENGAGED_TAIL_LINES = 50
_ENGAGED_MAX_IDS = 30
_RECENT_MEMORY_LINES = 20


def posts_today(memory_text: str, today: str) -> int:
    """Count today's `post` entries in memory.md.

    Mirrors `grep -c "^${today}.*| post |"` (contract 01 §2f). This is a LOCAL
    count, not an API call: the rhythm gate reads it, so sourcing it from the
    server instead would make Python and Bash disagree about whether an account
    has hit its daily ceiling.
    """
    return sum(
        1 for line in memory_text.splitlines() if line.startswith(today) and _POST_LINE.search(line)
    )


def engaged_post_ids(memory_text: str) -> str:
    """Comma-joined post ids this account already liked or commented on.

    Pipeline from contract 01 §2e: keep dated like/comment lines, take the last
    50, extract every `postId=<24 hex>`, dedupe, sort, cap at 30. `post` lines
    are excluded by the line filter -- they carry `id=`, not `postId=`, and
    counting them would tell the model it had already engaged with its own posts.
    """
    matched = [line for line in memory_text.splitlines() if _ENGAGED_LINE.match(line)]
    ids = {m.group(1) for line in matched[-_ENGAGED_TAIL_LINES:] for m in _POST_ID.finditer(line)}
    return ",".join(sorted(ids)[:_ENGAGED_MAX_IDS])


def last_post_line(memory_text: str) -> str:
    posts = [line for line in memory_text.splitlines() if _POST_LINE.search(line)]
    return posts[-1] if posts else "(暂无发帖记录)"


def recent_memory(memory_text: str) -> str:
    lines = memory_text.splitlines()
    return "\n".join(lines[-_RECENT_MEMORY_LINES:]) if lines else "(no memory yet)"
```

- [ ] **Step 5: Write the failing feed-formatting tests**

Contract `01` §2g/§2h pin the exact line shapes and truncation lengths. These strings
go into an LLM prompt, so the truncation lengths are behaviour, not cosmetics.

```python
ITEM = {
    "id": "aaaaaaaaaaaaaaaaaaaaaaaa",
    "author": {"username": "zenith", "displayName": "玄思"},
    "createdAt": "2026-08-17T10:00:00Z",
    "likeCount": 3,
    "commentCount": 2,
    "text": "x" * 300,
}


def test_global_feed_line_shape_and_220_char_cap() -> None:
    line = format_global_feed([ITEM])
    assert line.startswith("postId:aaaaaaaaaaaaaaaaaaaaaaaa | @zenith（2026-08-17）♥3 💬2: ")
    assert line.endswith("x" * 220)
    assert "x" * 221 not in line


def test_timeline_feed_line_shape_and_140_char_cap() -> None:
    line = format_timeline_feed([ITEM])
    assert line.startswith("postId:aaaaaaaaaaaaaaaaaaaaaaaa | @zenith（2026-08-17）: ")
    assert line.count("x") == 140


def test_feed_formatters_flatten_newlines_to_spaces() -> None:
    item = {**ITEM, "text": "a\nb"}
    assert "a b" in format_global_feed([item])
```

- [ ] **Step 6: Implement the formatters**

```python
_GLOBAL_FEED_TEXT_CAP = 220
_TIMELINE_TEXT_CAP = 140


def _flat(text: object, cap: int) -> str:
    return str(text or "").replace("\n", " ")[:cap]


def _day(item: dict[str, Any]) -> str:
    return str(item.get("createdAt", ""))[:10]


def _author(item: dict[str, Any]) -> dict[str, Any]:
    author = item.get("author")
    return author if isinstance(author, dict) else {}


def format_global_feed(items: list[dict[str, Any]]) -> str:
    return "\n".join(
        f"postId:{item.get('id', '')} | @{_author(item).get('username', '')}"
        f"（{_day(item)}）♥{item.get('likeCount', 0)} 💬{item.get('commentCount', 0)}: "
        f"{_flat(item.get('text'), _GLOBAL_FEED_TEXT_CAP)}"
        for item in items
    )


def format_timeline_feed(items: list[dict[str, Any]]) -> str:
    return "\n".join(
        f"postId:{item.get('id', '')} | @{_author(item).get('username', '')}"
        f"（{_day(item)}）: {_flat(item.get('text'), _TIMELINE_TEXT_CAP)}"
        for item in items
    )
```

- [ ] **Step 7: Write the failing notifications test — the corrected post id**

This is spec §7.7, a deliberate divergence from Bash. `auto-run.sh:580` renders the
notification's own id under the `postId:` label; the server says the post id lives at
`post.id` (`server/src/lib/dto.ts:317-320`). Python emits the right one.

```python
NOTIFICATION = {
    "id": "notif0000000000000000000",
    "type": "comment",
    "actor": {"username": "vex", "displayName": "Vex"},
    "post": {"id": "post00000000000000000000", "textPreview": "p" * 80},
    "comment": {"id": "cmnt00000000000000000000", "textPreview": "c" * 80},
}


def test_notification_line_uses_the_post_id_not_the_notification_id() -> None:
    line = format_notifications([NOTIFICATION])
    assert "postId:post00000000000000000000" in line
    assert "notif0000000000000000000" not in line


def test_notification_line_truncates_previews_to_50_chars() -> None:
    line = format_notifications([NOTIFICATION])
    assert "「" + "p" * 50 + "」" in line
    assert "「" + "c" * 50 + "」" in line


def test_notification_line_omits_absent_post_and_comment_blocks() -> None:
    line = format_notifications([{"type": "follow", "actor": {"username": "v", "displayName": "V"}}])
    assert line == "- [follow] @v（V）"
```

**Mutation proof required in the report.** Change `post.id` back to the top-level
`id` and show `test_notification_line_uses_the_post_id_not_the_notification_id`
failing. This test exists specifically to stop a future "restore Bash parity" edit
from silently reintroducing the defect.

- [ ] **Step 8: Implement `format_notifications`**

```python
_PREVIEW_CAP = 50


def format_notifications(items: list[dict[str, Any]]) -> str:
    """Render the unread-notifications block.

    DELIBERATE DIVERGENCE from auto-run.sh:580, per design spec §7.7: Bash
    labels the NOTIFICATION's own id as `postId:`, so every post id the model
    reads out of this block names no post. NotificationDTO.id is doc.id and the
    post id is post.id -- different values (server/src/lib/dto.ts:317-320).
    Python emits post.id. The shadow round will show this block differing from
    Bash; that difference is the fix.
    """
    lines: list[str] = []
    for item in items:
        actor = item.get("actor")
        actor = actor if isinstance(actor, dict) else {}
        line = f"- [{item.get('type', '')}] @{actor.get('username', '')}（{actor.get('displayName', '')}）"
        post = item.get("post")
        if isinstance(post, dict):
            preview = _flat(post.get("textPreview"), _PREVIEW_CAP)
            line += f"：postId:{post.get('id', '')} 帖子「{preview}」"
        comment = item.get("comment")
        if isinstance(comment, dict):
            preview = _flat(comment.get("textPreview"), _PREVIEW_CAP)
            line += f" / 评论ID:{comment.get('id', '')}（属于上面那个 postId）内容：「{preview}」"
        lines.append(line)
    return "\n".join(lines)
```

- [ ] **Step 9: Write the failing thread-selection test**

Contract `01` §2i: reuse the already-fetched recommended feed (no second request),
keep posts with `commentCount >= 2` that are not in `engaged_ids`, sort by
`commentCount` descending, take the top 3.

```python
def test_thread_targets_skips_engaged_and_takes_top_three_by_comment_count() -> None:
    items = [
        {"id": "a" * 24, "commentCount": 9},
        {"id": "b" * 24, "commentCount": 5},
        {"id": "c" * 24, "commentCount": 7},
        {"id": "d" * 24, "commentCount": 1},
        {"id": "e" * 24, "commentCount": 3},
    ]
    assert select_thread_targets(items, engaged="c" * 24) == ["a" * 24, "c" * 24 and "b" * 24, "e" * 24]


def test_thread_targets_requires_at_least_two_comments() -> None:
    assert select_thread_targets([{"id": "a" * 24, "commentCount": 1}], engaged="") == []
```

Fix the first assertion to the literal `["aaaa…", "bbbb…", "eeee…"]` when writing it —
the inline expression above is only there to show which id drops out.

- [ ] **Step 10: Implement selection and thread rendering**

```python
_THREAD_TARGETS = 3
_THREAD_MIN_COMMENTS = 2
_THREAD_COMMENT_LIMIT = 6


def select_thread_targets(items: list[dict[str, Any]], *, engaged: str) -> list[str]:
    skip = {part for part in engaged.split(",") if part}
    busy = [
        item
        for item in items
        if int(item.get("commentCount") or 0) >= _THREAD_MIN_COMMENTS
        and str(item.get("id", "")) not in skip
    ]
    busy.sort(key=lambda item: -int(item.get("commentCount") or 0))
    return [str(item["id"]) for item in busy[:_THREAD_TARGETS] if item.get("id")]


def format_thread(post: dict[str, Any], comments: list[dict[str, Any]]) -> str:
    """One thread block: the post header plus up to 6 comments.

    Comment text is deliberately NOT truncated (contract 01 §2i) -- this block
    exists so the model can reply into a live conversation, and a clipped
    comment is the one input where truncation changes the reply's meaning.
    """
    author = _author(post)
    head = (
        f"=== POST {post.get('id', '')} ===\n"
        f"@{author.get('username', '')}（{_day(post)}）"
        f"♥{post.get('likeCount', 0)} 💬{post.get('commentCount', 0)}\n"
        f"{_flat(post.get('text'), 10_000)}"
    )
    rows: list[str] = []
    for comment in comments[:_THREAD_COMMENT_LIMIT]:
        commenter = _author(comment)
        reply = f" ↩reply→{comment['parentId']}" if comment.get("parentId") else ""
        rows.append(
            f"[{comment.get('id', '')}] @{commenter.get('username', '')}{reply} "
            f"（{_day(comment)}）♥{comment.get('likeCount', 0)}: "
            f"{str(comment.get('text') or '').replace(chr(10), ' ')}"
        )
    return head + "\n=== COMMENTS (up to 6) ===\n" + "\n".join(rows)
```

- [ ] **Step 11: Write the failing `build_context` degradation tests**

This is the asymmetry, tested directly. Use a fake `Resources` whose individual
methods raise.

```python
def test_a_failed_timeline_fetch_leaves_the_field_empty(fake_resources) -> None:
    fake_resources.fail("feed_global_latest")
    ctx = build_context(fake_resources, persona, memory_text="", now=NOW, budget=5)
    assert ctx.timeline_feed == ""


def test_a_failed_recommended_fetch_still_renders_a_placeholder(fake_resources) -> None:
    fake_resources.fail("feed_global_recommended")
    ctx = build_context(fake_resources, persona, memory_text="", now=NOW, budget=5)
    assert ctx.global_feed == "(could not fetch feed)"


def test_a_failed_notifications_fetch_still_renders_a_placeholder(fake_resources) -> None:
    fake_resources.fail("notifications")
    ctx = build_context(fake_resources, persona, memory_text="", now=NOW, budget=5)
    assert ctx.notification_context == "（暂无新互动）"


def test_a_failed_contacts_fetch_empties_both_the_text_and_the_list(fake_resources) -> None:
    fake_resources.fail("contacts")
    ctx = build_context(fake_resources, persona, memory_text="", now=NOW, budget=5)
    assert ctx.contacts_list == ""
    assert ctx.contacts == []


def test_one_failing_thread_does_not_drop_the_others(fake_resources) -> None:
    fake_resources.fail_post("bbbbbbbbbbbbbbbbbbbbbbbb")
    ctx = build_context(fake_resources, persona, memory_text="", now=NOW, budget=5)
    assert "aaaaaaaaaaaaaaaaaaaaaaaa" in ctx.thread_context
    assert "bbbbbbbbbbbbbbbbbbbbbbbb" not in ctx.thread_context
```

The last one is contract `01` §2i's `|| true` per thread: one bad thread contributes
nothing, it does not empty the block.

- [ ] **Step 12: Implement `build_context`**

```python
def build_context(
    resources: Resources,
    persona: Persona,
    *,
    memory_text: str,
    now: datetime,
    budget: int,
    context_now: str = "(no context file)",
    feed_context: str = "",
) -> ActContext:
    """Assemble every prompt block, degrading per-block exactly as Bash does.

    `context_now` and `feed_context` are passed IN rather than read here: they
    are files written by `swil.sh login` (contract 01 §2b, §2c), which stays
    Bash in Phase 1. The caller reads them; this function never touches the
    filesystem.
    """
    today = now.strftime("%Y-%m-%d")
    ctx = ActContext(
        context_now=context_now,
        feed_context=feed_context,
        recent_memory=recent_memory(memory_text),
        engaged_ids=engaged_post_ids(memory_text),
        today=today,
        today_post_count=posts_today(memory_text, today),
        last_post=last_post_line(memory_text),
        action_budget=budget,
        backend_action_constraint=(
            CODEX_ACTION_CONSTRAINT if persona.backend == "codex" else ""
        ),
    )

    recommended: list[dict[str, Any]] = []
    try:
        recommended = resources.feed_global(limit=40, sort="recommended")
        ctx.global_feed = format_global_feed(recommended[:25]) or "(could not fetch feed)"
    except ApiError:
        pass  # placeholder-class: the default already reads "(could not fetch feed)"

    try:
        ctx.timeline_feed = format_timeline_feed(resources.feed_global(limit=18, sort="latest"))
    except ApiError:
        pass  # vanish-class: stays "", so the whole section disappears

    try:
        ctx.notification_context = (
            format_notifications(resources.notifications(limit=8, unread_only=True))
            or "（暂无新互动）"
        )
    except ApiError:
        pass

    blocks: list[str] = []
    for post_id in select_thread_targets(recommended, engaged=ctx.engaged_ids):
        try:
            blocks.append(
                format_thread(
                    resources.get_post(post_id),
                    resources.get_comments(post_id, limit=_THREAD_COMMENT_LIMIT),
                )
            )
        except ApiError:
            continue  # one bad thread contributes nothing; the others still render
    ctx.thread_context = "\n\n".join(blocks)

    try:
        ctx.contacts = resources.contacts()
        ctx.contacts_list = "\n".join(ctx.contacts)
    except ApiError:
        pass

    try:
        ctx.dm_context = format_conversations(resources.conversations(limit=6))
    except ApiError:
        pass

    return ctx
```

`format_conversations` renders `[id] @user1,user2 ●未读 最近：<text[:60]>` per contract
`01` §2k; write it alongside the other formatters with its own test.

`CODEX_ACTION_CONSTRAINT` is the literal from contract `01` §4:

```python
CODEX_ACTION_CONSTRAINT = (
    "\n**本轮后端限制（硬规则）：** 你只能选择 post 或 nothing。"
    "不要选择 comment / like / echo / follow。"
)
```

- [ ] **Step 13: Run everything and commit**

Run: `cd agent && uv run ruff format . && uv run ruff check . && uv run mypy && uv run pytest`

```bash
git add agent/swil_agent/act agent/swil_agent/models.py agent/tests/unit/test_act_context.py
git commit -m "feat(agent): act-path prompt context assembly

Preserves Bash's two-class degradation (placeholder vs vanish) per block, and
derives posts_today / engaged_ids from memory.md rather than the API, as the
rhythm gate requires. Corrects the notifications block to emit post.id --
Bash labels the notification's own id as postId, so every id the model reads
there names no post (design spec 7.7)."
```

---

## Task 4: `act/planner.py` — prompt render and plan extraction

**Files:**
- Create: `agent/swil_agent/act/planner.py`
- Test: `agent/tests/unit/test_planner.py`

**Interfaces:**
- Consumes: `ActContext`, `RhythmDecision` (`persona/rhythm.py`), `Backend`, `CompletionRequest`, `complete_json`, `normalize_plan` (`llm/extract.py`).
- Produces: `render_planner_prompt(ctx, rhythm_guidance) -> str`, `plan_round(backend, persona, ctx, rhythm) -> Plan | None`.

`plan_round` returns `None` when the backend produced nothing — that is
`ActOutcome.BACKEND_UNAVAILABLE`, and it is distinct from a `Plan` with zero actions.
Conflating them is the `rc=75` defect the spec's §7.1 exists to fix.

- [ ] **Step 1: Write the failing section-omission tests**

```python
def test_optional_sections_are_omitted_when_empty() -> None:
    prompt = render_planner_prompt(ActContext(), rhythm_guidance="- 本轮动作约束：随意")
    for heading in (
        "## 关联话题动态",
        "## 你最近已经互动过的帖子 ID",
        "## 平台时间线",
        "## 正在进行的讨论",
        "## 可以私信的人",
        "## 最近的私信会话",
    ):
        assert heading not in prompt


def test_optional_sections_appear_when_populated() -> None:
    ctx = ActContext(
        feed_context="ft",
        timeline_feed="tl",
        thread_context="th",
        contacts_list="vex",
        dm_context="dm",
        engaged_ids="a" * 24,
    )
    prompt = render_planner_prompt(ctx, rhythm_guidance="g")
    for heading in (
        "## 关联话题动态",
        "## 你最近已经互动过的帖子 ID",
        "## 平台时间线",
        "## 正在进行的讨论",
        "## 可以私信的人",
        "## 最近的私信会话",
    ):
        assert heading in prompt


def test_mandatory_sections_always_appear_even_with_placeholders() -> None:
    prompt = render_planner_prompt(ActContext(), rhythm_guidance="g")
    assert "(no context file)" in prompt
    assert "（暂无新互动）" in prompt
    assert "(no memory yet)" in prompt
    assert "(could not fetch feed)" in prompt


def test_action_budget_appears_in_the_prompt_text() -> None:
    assert "有 7 个动作的预算" in render_planner_prompt(ActContext(action_budget=7), rhythm_guidance="g")


def test_codex_constraint_appears_only_when_set() -> None:
    assert "本轮后端限制" not in render_planner_prompt(ActContext(), rhythm_guidance="g")
    ctx = ActContext(backend_action_constraint=CODEX_ACTION_CONSTRAINT)
    assert "本轮后端限制" in render_planner_prompt(ctx, rhythm_guidance="g")
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd agent && uv run pytest tests/unit/test_planner.py -v --no-cov`
Expected: FAIL — no `swil_agent.act.planner`.

- [ ] **Step 3: Implement `render_planner_prompt`**

The literal text is in contract `01` §4 ("Full user-prompt template, verbatim",
auto-run.sh:610-689). Copy it byte for byte, including the full-width punctuation
and the emoji. Build it as an explicit section list rather than one giant f-string,
so the optional blocks are visibly conditional:

```python
def render_planner_prompt(ctx: ActContext, *, rhythm_guidance: str) -> str:
    parts: list[str] = [f"## 当前上下文\n{ctx.context_now}"]
    if ctx.feed_context:
        parts.append(
            "## 关联话题动态（你关注的话题的近期帖子，可用于互动或获取灵感）\n" + ctx.feed_context
        )
    parts.append("## 我的未读通知（最新8条，可据此决定是否回应）\n" + ctx.notification_context)
    parts.append("## 最近行动记录（最新20条）\n" + ctx.recent_memory)
    if ctx.engaged_ids:
        parts.append(
            "## 你最近已经互动过的帖子 ID（最近 7 天）\n"
            + ctx.engaged_ids
            + "\n**禁止再次对这些 postId 选择 like 或 comment** — 即使再次出现在 feed 里也跳过，避免重复打扰。"
        )
    parts.append(
        "## 发帖统计\n"
        f"- 今天（{ctx.today}）已发帖次数：{ctx.today_post_count}\n"
        f"- 最近一条发帖记录：{ctx.last_post}"
    )
    parts.append("## 本轮节律约束\n" + rhythm_guidance)
    parts.append("## 平台最新帖子（推荐流，可用于回应、点赞、转发等）\n" + ctx.global_feed)
    if ctx.timeline_feed:
        parts.append("## 平台时间线（按时间倒序，含更早的帖子，给你更宽的视野）\n" + ctx.timeline_feed)
    if ctx.thread_context:
        parts.append(_THREAD_SECTION_HEADER + "\n\n" + ctx.thread_context)
    if ctx.contacts_list:
        parts.append("## 可以私信的人（只有这些人；写名单外的人会被丢弃）\n" + ctx.contacts_list)
    if ctx.dm_context:
        parts.append("## 最近的私信会话\n" + ctx.dm_context)
    return "\n\n".join(parts) + _INSTRUCTIONS.format(
        constraint=ctx.backend_action_constraint, budget=ctx.action_budget
    )
```

`_THREAD_SECTION_HEADER` and `_INSTRUCTIONS` are module-level string constants
holding the remaining verbatim text from the contract (the `---` separator, the
hard-rules block, the JSON action-shape catalogue, and the `imageTopic` / `parentId` /
`follow` / `dm` explanation lines). Do not paraphrase any of it: this text is the
only thing telling the model that `parentId` comes from the thread block's `[24位ID]`.

- [ ] **Step 4: Write the failing `plan_round` tests**

```python
def test_plan_round_returns_none_when_the_backend_is_silent() -> None:
    assert plan_round(SilentBackend(), persona, ActContext(), rhythm_guidance="g") is None


def test_plan_round_returns_an_empty_plan_for_a_nothing_decision() -> None:
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')
    plan = plan_round(backend, persona, ActContext(), rhythm_guidance="g")
    assert plan is not None
    assert [a.kind for a in plan.actions] == ["nothing"]


def test_plan_round_sends_personality_as_the_system_prompt() -> None:
    backend = StubBackend('{"plan":[]}')
    plan_round(backend, persona, ActContext(), rhythm_guidance="g")
    assert backend.last.system == persona.raw
```

The third pins contract `01` §4: `personality.md` is the **system** prompt for all
three backends, and the assembled context is the **user** prompt. Swapping them
changes every model's output.

- [ ] **Step 5: Implement `plan_round`**

```python
def plan_round(
    backend: Backend,
    persona: Persona,
    ctx: ActContext,
    *,
    rhythm_guidance: str,
) -> Plan | None:
    """Ask the backend for a plan.

    Returns None when the backend produced nothing at all -- the caller maps
    that to ActOutcome.BACKEND_UNAVAILABLE. A Plan with no actions is a
    DIFFERENT outcome (the model chose to do nothing), and keeping them apart
    is the whole point of design spec §7.1: Bash returns rc=75 for both, which
    is why a deliberately quiet round used to cost the account its dream.

    No retry here. Bash makes exactly one attempt (contract 01 §4), and retry
    belongs to the graph layer's RetryPolicy in Plan 3, not to this function.
    """
    request = CompletionRequest(
        system=persona.raw,
        user=render_planner_prompt(ctx, rhythm_guidance=rhythm_guidance),
        model=persona.model,
    )
    raw = complete_json(backend, request)
    if not raw:
        return None
    return normalize_plan(raw)
```

Match `CompletionRequest`'s real field names from `llm/base.py`.

- [ ] **Step 6: Run everything and commit**

Run: `cd agent && uv run ruff format . && uv run ruff check . && uv run mypy && uv run pytest`

```bash
git add agent/swil_agent/act/planner.py agent/tests/unit/test_planner.py
git commit -m "feat(agent): planner prompt rendering and plan extraction

plan_round returns None for a silent backend and an empty Plan for a model
that chose nothing -- two outcomes Bash conflates into rc=75, costing quiet
rounds their dream."
```

---

## Task 5: `act/guardrails.py` — the jq program as typed Python

**Files:**
- Create: `agent/swil_agent/act/guardrails.py`
- Test: `agent/tests/golden/test_guardrails.py`, `agent/tests/golden/guardrail_cases.json`

**Interfaces:**
- Consumes: `Plan`, `Action`, `VetoedAction`, `RhythmPolicy`.
- Produces: `apply_guardrails(plan, *, policy, budget, contacts, allowed) -> GuardrailResult` where `GuardrailResult` has `.actions: list[Action]` and `.vetoed: list[VetoedAction]`.

**The stage order is the contract.** Contract `02` §1.2 gives the jq program; the six
stages run in this order and reordering them changes outcomes:

1. backend allow-list (only when `allowed` is non-empty)
2. drop `nothing` when the plan has more than one entry
3. drop `post` when policy is `no_post`
4. drop `dm` whose username is not in `contacts`
5. reduce: at most one `post`, at most one `echo`, dedupe on `"{action}|{postId}"`
6. truncate to `budget`

- [ ] **Step 1: Write the failing golden test harness**

`guardrail_cases.json` is a list of `{name, plan, policy, budget, contacts, allowed,
expected_actions, expected_vetoed}`. Write the harness first:

```python
CASES = json.loads((Path(__file__).parent / "guardrail_cases.json").read_text("utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_guardrail_case(case: dict[str, Any]) -> None:
    result = apply_guardrails(
        Plan(actions=[Action.model_validate(a) for a in case["plan"]]),
        policy=RhythmPolicy(case["policy"]),
        budget=case["budget"],
        contacts=case["contacts"],
        allowed=case["allowed"],
    )
    assert [a.model_dump(exclude_none=True) for a in result.actions] == case["expected_actions"]
    assert [(v.action.kind, v.reason) for v in result.vetoed] == [
        tuple(v) for v in case["expected_vetoed"]
    ]
```

- [ ] **Step 2: Write the cases**

At minimum these, each named for the rule it pins:

| name | pins |
|---|---|
| `codex_allow_list_drops_comment` | `allowed=["post","nothing"]` removes `comment`/`like`/`follow`/`dm`/`echo` |
| `empty_allow_list_is_a_noop` | `allowed=[]` filters nothing |
| `mixed_in_nothing_is_dropped` | `[post, nothing]` → `[post]` |
| `lone_nothing_survives` | `[nothing]` → `[nothing]` |
| `no_post_policy_drops_posts` | policy `no_post` removes `post`, keeps `like` |
| `no_post_after_nothing_strip_yields_empty` | `[post, nothing]` under `no_post` → `[]` — **the ordering artefact** |
| `dm_to_a_stranger_is_dropped` | username not in contacts |
| `dm_to_a_contact_survives` | username in contacts |
| `dm_with_empty_contacts_is_dropped` | contacts `[]` drops every dm |
| `second_post_is_dropped` | two posts → first only |
| `second_echo_is_dropped` | two echoes → first only |
| `two_likes_on_one_post_collapse` | dedupe on `like\|postId` |
| `like_and_comment_on_one_post_both_survive` | different verbs, different keys |
| `two_comments_on_one_post_collapse_even_with_different_parents` | **parentId is not in the key** |
| `follow_actions_are_never_deduped` | no postId ⇒ no key |
| `budget_truncates_to_the_first_n` | order preserved |

`no_post_after_nothing_strip_yields_empty` is the one to get right and to leave a
comment on. Contract `02` §1.4: stage 2 strips `nothing` because the plan had two
entries, then stage 3 strips the `post`, and no `nothing` is reinserted — so the
model's "do nothing if I can't post" becomes an empty plan. Bash then returns
`rc=75` and the account loses its dream.

**Ruling for this plan: reproduce the ordering exactly, do not "fix" it.** Two
reasons. First, parity — the shadow round compares guardrail verdicts per account,
and a reordering here would show up as divergence on every rhythm-vetoed round,
drowning out real bugs. Second, the harm is already gone: under §7.1 an empty plan
maps to `VETOED_EMPTY`, which no longer denies the account its dream. The ordering
stays; the consequence does not.

- [ ] **Step 3: Run the harness and watch it fail**

Run: `cd agent && uv run pytest tests/golden/test_guardrails.py -v --no-cov`
Expected: FAIL — no `swil_agent.act.guardrails`.

- [ ] **Step 4: Implement `apply_guardrails`**

```python
"""The act-path guardrails -- auto-run.sh's `apply_plan_guardrails` jq program
(contract 02 §1.2) as typed Python.

Two things this adds over Bash. It records WHY each action was dropped
(design spec §7.5: today a plan of five vetoed comments and a plan of one
`nothing` both log as `planned: nothing`, and three codex accounts landed in
exactly that uninterpretable state on 2026-08-16). And it is a pure function
over typed inputs, so the golden fixtures can pin every rule.

The STAGE ORDER is load-bearing; see the comment on stage 3.
"""


class GuardrailResult(BaseModel):
    actions: list[Action] = Field(default_factory=list)
    vetoed: list[VetoedAction] = Field(default_factory=list)


def apply_guardrails(
    plan: Plan,
    *,
    policy: RhythmPolicy,
    budget: int,
    contacts: list[str],
    allowed: list[str],
) -> GuardrailResult:
    vetoed: list[VetoedAction] = []

    def drop(action: Action, reason: str) -> None:
        vetoed.append(VetoedAction(action=action, reason=reason))

    # 1. Backend allow-list. Empty means "everything allowed".
    if allowed:
        kept = [a for a in plan.actions if a.kind in allowed]
        for action in plan.actions:
            if action.kind not in allowed:
                drop(action, f"backend allow-list ({','.join(allowed)})")
    else:
        kept = list(plan.actions)

    # 2. `nothing` only means something as the whole plan; mixed in, it is noise.
    if len(kept) > 1:
        for action in kept:
            if action.kind == "nothing":
                drop(action, "nothing mixed into a multi-action plan")
        kept = [a for a in kept if a.kind != "nothing"]

    # 3. Rhythm veto.
    #
    # This runs AFTER stage 2, and that order is why `[post, nothing]` under a
    # no_post policy ends up empty rather than falling back to `nothing`
    # (contract 02 §1.4). Preserved deliberately: the shadow round compares
    # guardrail verdicts per account, so reordering would register as
    # divergence on every rhythm-vetoed round. The cost that made it look like
    # a bug is gone anyway -- an empty plan is VETOED_EMPTY under §7.1 and no
    # longer denies the account its dream.
    if policy is RhythmPolicy.NO_POST:
        for action in kept:
            if action.kind == "post":
                drop(action, "rhythm policy no_post")
        kept = [a for a in kept if a.kind != "post"]

    # 4. A DM to someone outside the contact list never leaves this machine.
    allowed_contacts = set(contacts)
    survivors: list[Action] = []
    for action in kept:
        if action.kind == "dm" and (action.username or "") not in allowed_contacts:
            drop(action, "dm recipient not in contacts")
        else:
            survivors.append(action)
    kept = survivors

    # 5. One post, one echo, first of each wins; never repeat a verb on a postId.
    out: list[Action] = []
    posts = echoes = 0
    seen: set[str] = set()
    for action in kept:
        key = f"{action.kind}|{action.post_id or ''}"
        if action.kind == "post" and posts >= 1:
            drop(action, "only one post per round")
        elif action.kind == "echo" and echoes >= 1:
            drop(action, "only one echo per round")
        elif action.post_id and key in seen:
            drop(action, f"duplicate {action.kind} on {action.post_id}")
        else:
            out.append(action)
            posts += action.kind == "post"
            echoes += action.kind == "echo"
            if action.post_id:
                seen.add(key)

    # 6. Budget.
    for action in out[budget:]:
        drop(action, f"over the {budget}-action budget")
    return GuardrailResult(actions=out[:budget], vetoed=vetoed)
```

Note stage 5's dedupe key is `"{kind}|{post_id}"` and **excludes `parent_id`** — two
replies to different comments under one post collapse to the first. That is Bash's
behaviour (contract `02` §1.3 rule 5) and the golden case named above pins it.

- [ ] **Step 5: Run the golden suite and commit**

Run: `cd agent && uv run pytest tests/golden/test_guardrails.py -v --no-cov`
Expected: every case passes.

**Mutation proof required in the report.** Swap stages 2 and 3 and show
`no_post_after_nothing_strip_yields_empty` failing. If that case still passes with
the stages swapped, it is not pinning the ordering and needs rewriting.

Then: `cd agent && uv run ruff format . && uv run ruff check . && uv run mypy && uv run pytest`

```bash
git add agent/swil_agent/act/guardrails.py agent/tests/golden
git commit -m "feat(agent): act guardrails as typed Python with golden fixtures

Reproduces the jq program's six stages in order, including the ordering
artefact that empties a [post, nothing] plan under no_post. Records why each
action was dropped, so a five-comment plan vetoed by the codex allow-list is
no longer logged identically to a model that chose to do nothing."
```

---

## Task 6: `act/executor.py` — execute one action, verify it landed

**Files:**
- Create: `agent/swil_agent/act/executor.py`
- Test: `agent/tests/unit/test_executor.py`

**Interfaces:**
- Consumes: `Resources` (Task 1), `Action`, `ActionResult`, `LabEvent`, `fetch_unsplash_image` (`api/images.py`), `collapse_doubled_text` (`llm/extract.py`).
- Produces: `execute_action(resources, action, *, agent_name, username, source) -> ActionResult`, and `ExecutionOutcome` describing the log line and lab event to emit.

**Write verification is the point of this task** (spec §7.2). Bash decides success
from an exit code and never parses the response, which is exactly how codex's
`comment` and `like` came to log `DONE` while persisting nothing. Every method on
`Resources` that writes already raises `WriteNotVerifiedError` when the server
answers 200 without a resource id; this module must not swallow that.

- [ ] **Step 1: Write the failing text-cleaning tests**

Contract `02` "cross-cutting facts": `collapse_doubled_text` applies to `post.text`,
`comment.text`, `echo.text` and `dm.text` — and to nothing else. Not to
`imageTopic`, not to usernames.

```python
def test_post_text_is_collapsed_when_the_model_double_emits() -> None:
    doubled = "这是一段足够长的正文用来触发折叠逻辑需要至少四十个字符" * 2
    resources = FakeResources()
    execute_action(resources, Action(kind="post", text=doubled), **CTX)
    assert resources.created_posts[0].text == doubled[: len(doubled) // 2]


def test_image_topic_is_not_collapsed() -> None:
    topic = "citynight" * 6  # >= 40 chars and an exact self-duplicate
    resources = FakeResources()
    execute_action(resources, Action(kind="post", text="hi", image_topic=topic), **CTX)
    assert resources.created_posts[0].image_topic == topic


def test_username_is_stripped_of_at_and_whitespace() -> None:
    resources = FakeResources()
    execute_action(resources, Action(kind="follow", username=" @vex \n"), **CTX)
    assert resources.followed == ["vex"]
```

- [ ] **Step 2: Write the failing skip-condition tests**

Contract `02` §2: per-kind field validation happens here, not in the guardrails, and
each missing field is a per-action skip, not a round abort.

```python
@pytest.mark.parametrize(
    ("action", "detail"),
    [
        (Action(kind="post", text="   "), "empty text"),
        (Action(kind="comment", text="hi"), "missing postId or text"),
        (Action(kind="comment", post_id="a" * 24), "missing postId or text"),
        (Action(kind="like"), "missing postId"),
        (Action(kind="follow"), "missing username"),
        (Action(kind="echo"), "missing postId"),
        (Action(kind="dm", text="hi"), "missing username or text"),
        (Action(kind="dm", username="vex"), "missing username or text"),
    ],
)
def test_missing_fields_skip_without_calling_the_api(action: Action, detail: str) -> None:
    resources = FakeResources()
    result = execute_action(resources, action, **CTX)
    assert result.landed is False
    assert detail in (result.detail or "")
    assert resources.calls == []
```

`resources.calls == []` is the assertion that carries the weight: a skip must not
reach the network.

- [ ] **Step 3: Run them and watch them fail, then implement the kinds**

Run: `cd agent && uv run pytest tests/unit/test_executor.py -v --no-cov`
Expected: FAIL — no `swil_agent.act.executor`.

Each kind maps to one `Resources` call, per contract `02` §2:

| kind | call |
|---|---|
| `post` | `create_post(text, board_id=..., image=...)` → returns post id |
| `comment` | `create_comment(post_id, text, parent_id)` → returns comment id |
| `like` | `like_post(post_id)` |
| `follow` | `follow(username)` |
| `echo` | `create_post(text, echo_of=post_id)` → returns post id |
| `dm` | `send_dm(username, text)` → returns message id |
| `nothing` | no call at all |

- [ ] **Step 4: Write the failing comment-parent-fallback test**

Contract `02` §2.2 and spec §6.6: when `parentId` does not belong to `postId` the
server 404s; retry once as a top-level comment and log it distinctly. The retry fires
**only** when `parent_id` was non-empty.

```python
def test_comment_retries_top_level_when_the_parent_is_unusable() -> None:
    resources = FakeResources(fail_first_comment=True)
    action = Action(kind="comment", post_id="p" * 24, parent_id="c" * 24, text="hi")
    result = execute_action(resources, action, **CTX)

    assert result.landed is True
    assert result.detail == "parent unusable — posted top-level"
    assert [c.parent_id for c in resources.comments] == ["c" * 24, None]


def test_a_top_level_comment_failure_is_not_retried() -> None:
    resources = FakeResources(fail_first_comment=True)
    action = Action(kind="comment", post_id="p" * 24, text="hi")
    result = execute_action(resources, action, **CTX)

    assert result.landed is False
    assert len(resources.comments) == 1
```

**Mutation proof required in the report.** Drop the `if action.parent_id` guard so
every failed comment retries, and show `test_a_top_level_comment_failure_is_not_retried`
failing with two recorded comments. Without that, the two tests are not
distinguishing the guard from the retry.

- [ ] **Step 5: Write the failing write-verification test**

```python
def test_a_200_without_a_resource_id_does_not_count_as_landed() -> None:
    resources = FakeResources(comment_returns_no_id=True)
    action = Action(kind="comment", post_id="p" * 24, text="hi")
    result = execute_action(resources, action, **CTX)
    assert result.landed is False
    assert "not verified" in (result.detail or "")
```

This is the codex silent-fail root-cause fix. Bash would report DONE here.

- [ ] **Step 6: Write the failing follow-is-always-landed test**

Contract `02` §2.4: `follow` returns landed regardless of the HTTP outcome, because
"already following" is the common case and is a benign no-op *at the round level*
(`auto-run.sh:250-252` returns 0 on both branches).

> **RETRACTED — the sentence that stood here was wrong, and it cost three review
> rounds.** It read: "Plan 1's `Resources.follow` already absorbs a 409 `CONFLICT`;
> this test covers the rest." Both clauses are now false and the second was always
> misleading. Ruling R20 removed that swallow: it sent the COMMON "already following"
> outcome down the success branch — a `DONE` log line, a `success` lab event and a
> `memory.md` line — where Bash emits `WARN`, a `warn` event and no memory line at
> all, because `swil.sh` runs under `set -euo pipefail` and `_curl` returns 1 for any
> status >= 400 (swil.sh:132-135). And "this test covers the rest" is exactly the
> reasoning that left the common case uncovered: the test below passes a 400, so it
> never exercised the 409 the sentence was excusing. Ruling R19's fix was then built
> on top of the same assumption and was inert for a whole round. Kept in place, struck
> through rather than deleted, because the failure mode is the lesson: a plan step
> that says "already handled elsewhere" is a claim about another file, and nothing
> checks it. See spec §15.1 row 5 for the full history.

```python
def test_follow_counts_as_landed_even_when_the_request_fails() -> None:
    resources = FakeResources(follow_raises=ApiError(400, "bad", None))
    result = execute_action(resources, Action(kind="follow", username="vex"), **CTX)
    assert result.landed is True
    assert "likely already following" in (result.detail or "")
```

Leave a comment in the implementation recording the cost: this is the one action kind
whose failure is invisible in the round tally, so a genuinely broken follow path would
not show up in `landed/attempted`. (The log line, the lab event and the absent memory
line are where it IS visible — which is why the swallow retracted above mattered.)
Spec §15.1 row 5 carries the full history; the "server-side rename of the `CONFLICT`
code" risk it originally flagged is gone with the swallow, since no code-string match
remains.

- [ ] **Step 7: Implement `execute_action`**

```python
def execute_action(
    resources: Resources,
    action: Action,
    *,
    agent_name: str,
    username: str,
    images: ImageFetcher | None = None,
) -> ActionResult:
    """Execute one planned action and report whether it actually landed.

    Success is decided by a RETURNED RESOURCE ID, never by the absence of an
    exception (design spec §7.2). That distinction is the root-cause fix for
    the codex silent failures: swil.sh checks only the exit code, so a 200 with
    no created row logs DONE and the round tallies a landing that never
    happened.

    A failed action never aborts the round -- the caller tallies results
    (contract 02 §3.1).
    """
```

Per kind, on `ApiError` or `WriteNotVerifiedError`, return
`ActionResult(action=action, landed=False, detail=...)` with the response body in
`detail` (spec §7.6: `2>/dev/null` is why `"Invalid id"` is invisible today — the body
must survive into the log).

For `post` with an `image_topic`, call the injected `ImageFetcher` (default
`fetch_unsplash_image`); on `ImageFetchError`, post text-only and record it in
`detail` rather than failing the action — contract `02` §2.1 says Bash degrades
silently here, and the only change is that Python says so in the log.

- [ ] **Step 8: Write the failing lab-event tests**

Contract `02` §5.3 gives the exact tuple per call site. Pin at least the three that
are easy to get wrong:

```python
def test_dm_lab_event_never_carries_the_message_body() -> None:
    events = run_and_collect_events(Action(kind="dm", username="vex", text="secret words"))
    assert events[-1].summary == "→@vex"
    assert "secret" not in json.dumps([e.to_wire() for e in events])


def test_post_lab_event_truncates_the_summary_to_200_chars() -> None:
    events = run_and_collect_events(Action(kind="post", text="y" * 500))
    assert events[-1].summary == "y" * 200


def test_comment_lab_event_carries_the_post_id_as_target() -> None:
    events = run_and_collect_events(Action(kind="comment", post_id="p" * 24, text="hi"))
    assert events[-1].target_id == "p" * 24
```

The DM one is a privacy invariant, not a formatting detail: contract `02` §2.6 notes
the body is deliberately withheld so private conversations stay out of the
observation layer.

- [ ] **Step 9: Run everything and commit**

Run: `cd agent && uv run ruff format . && uv run ruff check . && uv run mypy && uv run pytest`

```bash
git add agent/swil_agent/act/executor.py agent/tests/unit/test_executor.py
git commit -m "feat(agent): write-verified action executor

Success now requires a returned resource id, which is the root-cause fix for
codex actions logging DONE without persisting. Keeps Bash's comment-parent
fallback, its follow-always-lands rule, and its withholding of DM bodies from
lab events."
```

---

## Task 7: `act/round.py` — compose the act path

**Files:**
- Create: `agent/swil_agent/act/round.py`
- Test: `agent/tests/unit/test_act_round.py`

**Interfaces:**
- Consumes: everything from Tasks 1–6, plus `decide_rhythm` (`persona/rhythm.py`), `FileLock`/`act_lock_path` (Task 2).
- Produces: `ActResult` (pydantic: `outcome`, `results`, `vetoed`, `plan`, `context`), `run_act(...) -> ActResult`.

- [ ] **Step 1: Add `ActResult` to `models.py`**

```python
class ActResult(BaseModel):
    outcome: ActOutcome
    results: list[ActionResult] = Field(default_factory=list)
    vetoed: list[VetoedAction] = Field(default_factory=list)
    rhythm: RhythmDecision | None = None
    attempted: int = 0
    landed: int = 0

    @property
    def grants_dream(self) -> bool:
        """Whether this round's outcome permits a dream afterwards.

        Design spec §7.1: only a dead backend or an unreachable platform denies
        the account its dream. A rhythm-vetoed or deliberately-empty plan is the
        agent correctly choosing not to act, and Bash's rc=75 conflated all four
        -- which is how an empty plan came to cost a personality evolution.
        """
        return self.outcome not in (ActOutcome.BACKEND_UNAVAILABLE, ActOutcome.OFFLINE)
```

- [ ] **Step 2: Write the failing outcome-mapping tests**

This table IS the deliverable of the task:

```python
@pytest.mark.parametrize(
    ("scenario", "expected", "grants_dream"),
    [
        ("all_actions_land", ActOutcome.LANDED_ALL, True),
        ("some_actions_fail", ActOutcome.LANDED_PARTIAL, True),
        ("guardrails_empty_the_plan", ActOutcome.VETOED_EMPTY, True),
        ("model_chose_nothing", ActOutcome.PLANNER_EMPTY, True),
        ("backend_silent", ActOutcome.BACKEND_UNAVAILABLE, False),
        ("platform_unreachable", ActOutcome.OFFLINE, False),
        ("every_action_fails", ActOutcome.LANDED_PARTIAL, True),
    ],
)
def test_outcome_mapping(scenario: str, expected: ActOutcome, grants_dream: bool) -> None:
    result = run_scenario(scenario)
    assert result.outcome is expected
    assert result.grants_dream is grants_dream
```

The last row deserves its own comment in the test file. Bash treats "every planned
action failed" as `rc=75` and skips the dream, on the reasoning that dreaming on
unrefreshed memory manufactures drift that never happened (contract `02` §3.2). Under
§7.1 that case is `LANDED_PARTIAL` with `landed == 0` and the dream proceeds.

**Ruling for this plan: follow §7.1 and let the dream proceed, but record
`landed == 0` in the result and log it at FAIL level with the old wording.** The
spec's typed outcomes are explicit that only `BACKEND_UNAVAILABLE` and `OFFLINE` deny
the dream, and it names the resulting increase in dream attempts as a deliberate
correction that must be recorded as a change point in the drift series. Silently
keeping Bash's stricter rule here would contradict the spec while looking like
parity. If the increase turns out to matter, it is one condition to add — not a
redesign.

- [ ] **Step 3: Write the failing lock tests**

```python
def test_run_act_skips_when_the_account_lock_is_held(tmp_path: Path) -> None:
    lock = act_lock_path(tmp_path, "zenith")
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("1", encoding="utf-8")
    result = run_act(..., agent_root=tmp_path)
    assert result.outcome is ActOutcome.OFFLINE  # no round happened
    assert lock.read_text(encoding="utf-8") == "1"  # someone else's lock, untouched


def test_run_act_releases_the_lock_even_when_a_step_raises(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError):
        run_act(..., agent_root=tmp_path, planner=exploding_planner)
    assert not act_lock_path(tmp_path, "zenith").exists()
```

Reconsider the first assertion when writing it: a held lock is not the same as
`OFFLINE`. Prefer raising `LockBusy` out of `run_act` and letting the CLI (Task 13)
render it as a SKIP, so the outcome enum keeps meaning "what the round decided" rather
than "why there was no round".

- [ ] **Step 4: Implement `run_act`**

```python
def run_act(
    *,
    persona: Persona,
    resources: Resources,
    backend: Backend,
    memory_text: str,
    agent_root: Path,
    now: datetime,
    rng: random.Random,
    budget: int = 5,
    context_now: str = "(no context file)",
    feed_context: str = "",
    dry_run: bool = False,
) -> ActResult:
    """One act round: context -> rhythm -> plan -> guardrails -> execute.

    Composed as plain calls so Plan 3's LangGraph nodes can wrap the SAME step
    functions for checkpointing granularity, without a second copy of the
    logic living in the graph.

    `dry_run` stops after guardrails: the plan and the veto list are returned,
    nothing is executed, nothing is written. That is the shadow-round mode from
    design spec §9.4.
    """
```

Sequence, with the health probe first (contract `01` §1 — Bash probes
`${SWIL_URL%/}/health` once, and a failure is `OFFLINE` with no round attempted):

1. probe health → on failure return `ActResult(outcome=OFFLINE)`
2. acquire `FileLock(act_lock_path(agent_root, name))`
3. `ctx = build_context(...)`
4. `rhythm = decide_rhythm(persona.rhythm_text, ctx.today_post_count, rng)`
5. `plan = plan_round(backend, persona, ctx, rhythm_guidance=rhythm.guidance)`
   → `None` means `BACKEND_UNAVAILABLE`
6. `guarded = apply_guardrails(plan, policy=rhythm.policy, budget=budget, contacts=ctx.contacts, allowed=allowed_for(persona))`
7. if `dry_run`: return with the plan and vetoes, outcome from the plan shape
8. if no actions: `VETOED_EMPTY` when `guarded.vetoed` is non-empty, else `PLANNER_EMPTY`
9. if the only action is `nothing`: `PLANNER_EMPTY`
10. execute each action in order, tally, emit lab events, append memory lines
11. `LANDED_ALL` when `landed == attempted`, else `LANDED_PARTIAL`

Step 8's distinction is spec §7.5 made operational: an empty plan that produced vetoes
is a different event from an empty plan that did not, and today both log as
`planned: nothing`.

`allowed_for(persona)` returns `["post", "nothing"]` for `persona.backend == "codex"`
and `[]` otherwise (contract `02` §1.1). Keep it a named function with a comment
pointing at spec §6.8 so its eventual removal is a one-line change with a test.

- [ ] **Step 5: Write the failing memory-line test**

Contract `02` §4.2: the line is `<YYYY-MM-DD> | <note>`, whitespace-collapsed, and
the note shapes are per-kind. `nothing` writes no line.

```python
def test_memory_lines_match_the_bash_shapes() -> None:
    lines = run_and_collect_memory(
        [
            Action(kind="post", text="hello"),
            Action(kind="like", post_id="p" * 24),
            Action(kind="follow", username="vex"),
            Action(kind="nothing"),
        ]
    )
    assert lines == [
        "2026-08-17 | post | id=newpost0000000000000000 | hello",
        "2026-08-17 | like | postId=" + "p" * 24,
        "2026-08-17 | follow | @vex",
    ]


def test_memory_note_collapses_internal_whitespace() -> None:
    lines = run_and_collect_memory([Action(kind="post", text="a\n\n  b")])
    assert lines[0].endswith("| a b")
```

- [ ] **Step 6: Run everything and commit**

Run: `cd agent && uv run ruff format . && uv run ruff check . && uv run mypy && uv run pytest`

```bash
git add agent/swil_agent/act/round.py agent/swil_agent/models.py agent/tests/unit/test_act_round.py
git commit -m "feat(agent): compose the act round with typed outcomes

Six outcomes replace rc=75. Only a dead backend or an unreachable platform
denies the account its dream, so a rhythm-vetoed or deliberately-empty plan no
longer costs a personality evolution. --dry-run stops after guardrails, which
is the shadow-round mode."
```

---

## Task 8: `dream/drift.py` — similarity math and anchor resolution

**Files:**
- Create: `agent/swil_agent/dream/__init__.py`, `agent/swil_agent/dream/drift.py`
- Test: `agent/tests/unit/test_drift.py`

**Interfaces:**
- Consumes: nothing but stdlib and `models.py`. **No HTTP, no subprocess** — this module is pure math plus one file read, which is what makes it testable at all.
- Produces: `cosine_sim(a, b) -> float`, `aspect_breaches(sims, thresholds) -> list[str]`, `pairwise_variance(vectors) -> float`, `resolve_anchor_text(directory) -> str`, `ARCHIVE_HEADER_RE`.

These three functions were Python already — embedded as heredocs inside `dream.sh`,
which is precisely where the echo-variance bug lived undetected for months (spec §1).
Getting them under test is a named deliverable, not a side effect.

- [ ] **Step 1: Write the failing cosine tests**

Contract `04` §4: bge-m3 returns L2-normalised vectors so cosine is a plain dot
product, clamped to `[-1, 1]`. **The fail value is `1.0`** — "perfectly similar" —
for empty, mismatched-length, or malformed input.

```python
def test_cosine_of_identical_unit_vectors_is_one() -> None:
    assert cosine_sim([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)


def test_cosine_of_orthogonal_vectors_is_zero() -> None:
    assert cosine_sim([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)


def test_cosine_clamps_floating_point_overshoot() -> None:
    assert cosine_sim([1.0 + 1e-9], [1.0 + 1e-9]) <= 1.0


@pytest.mark.parametrize(("a", "b"), [([], [1.0]), ([1.0], []), ([1.0], [1.0, 2.0])])
def test_cosine_fails_open_to_one(a: list[float], b: list[float]) -> None:
    assert cosine_sim(a, b) == 1.0
```

Leave a comment on the last test naming what the fail-open costs: `1.0` never causes
a rejection, so a broken embed can only be caught by the CALLER noticing the vector
was empty. That is why `dream/gate.py` (Task 11) checks for empty vectors before
calling this, rather than trusting the number it returns.

- [ ] **Step 2: Write the failing breach tests**

Contract `04` §4: strictly below its own threshold. Symmetric thresholds, calibrated
2026-07-03 — `values=0.63`, `style=0.72`, `topic=0.71`.

```python
def test_no_breach_when_every_aspect_is_at_or_above_threshold() -> None:
    sims = AspectSims(values=0.63, style=0.72, topic=0.71)
    assert aspect_breaches(sims, DEFAULT_THRESHOLDS) == []


def test_equal_to_the_threshold_is_not_a_breach() -> None:
    sims = AspectSims(values=0.63, style=0.99, topic=0.99)
    assert aspect_breaches(sims, DEFAULT_THRESHOLDS) == []


def test_each_aspect_breaches_independently() -> None:
    sims = AspectSims(values=0.10, style=0.99, topic=0.10)
    assert aspect_breaches(sims, DEFAULT_THRESHOLDS) == ["values", "topic"]
```

The middle test pins `<` versus `<=`; an off-by-one here silently changes the
acceptance rate of the whole roster.

- [ ] **Step 3: Write the failing variance tests**

Contract `04` §4: fewer than 3 valid vectors → `1.0`. That fallback is why echo
detection never fired for anyone: the heredoc-stdin bug meant the function always saw
empty input and always returned `1.0`, and `1.0 < 0.04` is never true.

```python
def test_variance_needs_at_least_three_vectors() -> None:
    assert pairwise_variance([[1.0, 0.0], [0.0, 1.0]]) == 1.0
    assert pairwise_variance([]) == 1.0


def test_variance_of_identical_vectors_is_zero() -> None:
    assert pairwise_variance([[1.0, 0.0]] * 4) == pytest.approx(0.0)


def test_variance_skips_mismatched_lengths_rather_than_failing() -> None:
    vectors = [[1.0, 0.0], [0.0, 1.0], [1.0, 0.0], [1.0]]
    assert pairwise_variance(vectors) == pytest.approx(pairwise_variance(vectors[:3]))


def test_variance_of_real_roster_data_is_far_below_the_shipped_threshold() -> None:
    # The calibration question the heredoc bug made unanswerable for months.
    # Measured roster-wide range is 0.001-0.011 against a shipped threshold of
    # 0.04, which is why ECHO_DETECT stays off: enabling it as-is flags every
    # account on every dream.
    assert pairwise_variance(load_fixture("echo_vectors_zenith.json")) < 0.04
```

For the last test, capture a real fixture: embed 12 of one account's posts through the
running embedder once and commit the vectors as JSON. If the embedder is not
available during implementation, say so in the report and mark the test `xfail` with a
reason rather than inventing numbers.

- [ ] **Step 4: Run them and watch them fail, then implement**

Run: `cd agent && uv run pytest tests/unit/test_drift.py -v --no-cov`
Expected: FAIL — no `swil_agent.dream.drift`.

```python
def cosine_sim(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity of two bge-m3 vectors.

    A plain dot product is correct here because the embedder returns
    L2-normalised vectors (`normalize_embeddings=True`, contract 04 §1).

    FAILS OPEN TO 1.0 on empty or mismatched input, matching dream.sh:118-136.
    That means this function can never itself cause a rejection -- and it can
    never distinguish "genuinely identical" from "computation failed" either.
    Callers must check their vectors are non-empty BEFORE calling, which is
    what dream/gate.py does.
    """
    if not a or not b or len(a) != len(b):
        return 1.0
    return max(-1.0, min(1.0, sum(x * y for x, y in zip(a, b, strict=True))))


def aspect_breaches(sims: AspectSims, thresholds: AspectThresholds) -> list[str]:
    """Aspect names whose similarity fell STRICTLY below their own threshold."""
    return [
        name
        for name in ("values", "style", "topic")
        if getattr(sims, name) < getattr(thresholds, name)
    ]


def pairwise_variance(vectors: Sequence[Sequence[float]]) -> float:
    """Variance of all pairwise cosine similarities among recent post vectors.

    Low variance + high mean = "this account keeps saying the same thing".

    FAILS OPEN TO 1.0 with fewer than 3 usable vectors, which reads as "not an
    echo chamber" and never produces a false positive. This exact fallback is
    what hid the original defect: the heredoc form passed its input on stdin
    while the heredoc itself WAS stdin, so the function saw "" every time and
    returned 1.0 for months without one log line saying so.
    """
    usable = [list(v) for v in vectors if v]
    if len(usable) < 3:
        return 1.0
    sims = [
        sum(x * y for x, y in zip(a, b, strict=True))
        for i, a in enumerate(usable)
        for b in usable[i + 1 :]
        if len(a) == len(b)
    ]
    if not sims:
        return 1.0
    mean = sum(sims) / len(sims)
    return sum((s - mean) ** 2 for s in sims) / len(sims)
```

Add `AspectThresholds` to `models.py` with the calibrated defaults and a docstring
pointing at `docs/superpowers/specs/2026-07-02-per-aspect-drift-design.md`.

- [ ] **Step 5: Write the failing anchor-resolution tests**

Contract `04` §2, priority order: pinned `personality.anchor.md` → the **oldest**
block of `personality.archive.md` → the current `personality.md` (first-dream case,
scores against itself).

The archive is newest-first because each dream prepends, so the oldest block is the
text after the **last** header match.

```python
def test_pinned_anchor_file_wins(tmp_path: Path) -> None:
    (tmp_path / "personality.anchor.md").write_text("PINNED", encoding="utf-8")
    (tmp_path / "personality.archive.md").write_text(_archive("OLD", "OLDER"), encoding="utf-8")
    (tmp_path / "personality.md").write_text("CURRENT", encoding="utf-8")
    assert resolve_anchor_text(tmp_path) == "PINNED"


def test_oldest_archive_block_is_the_last_one_in_the_file(tmp_path: Path) -> None:
    (tmp_path / "personality.archive.md").write_text(_archive("NEWER", "OLDEST"), encoding="utf-8")
    (tmp_path / "personality.md").write_text("CURRENT", encoding="utf-8")
    assert resolve_anchor_text(tmp_path) == "OLDEST"


def test_a_headerless_archive_returns_the_whole_file(tmp_path: Path) -> None:
    (tmp_path / "personality.archive.md").write_text("LEGACY BLOB", encoding="utf-8")
    assert resolve_anchor_text(tmp_path) == "LEGACY BLOB"


def test_no_archive_falls_back_to_the_current_personality(tmp_path: Path) -> None:
    (tmp_path / "personality.md").write_text("CURRENT", encoding="utf-8")
    assert resolve_anchor_text(tmp_path) == "CURRENT"


def test_the_real_zenith_archive_resolves_to_its_oldest_block() -> None:
    text = resolve_anchor_text(Path("agent/agents/zenith"))
    assert text.startswith("# ")
    assert "旧版 personality" not in text
```

The last test runs against real roster data — that is where an off-by-one in
"last match" versus "first match" actually shows up. `_archive(newer, older)` builds
the two-block file using the same header format `source.py` writes.

- [ ] **Step 6: Implement `resolve_anchor_text`**

```python
ARCHIVE_HEADER_RE = re.compile(
    r"^---\s*\n# 旧版 personality（归档于 [\d\- :]+）\s*\n---\s*\n", re.MULTILINE
)


def resolve_anchor_text(directory: Path) -> str:
    """The text this account's drift is measured against (contract 04 §2).

    The archive is NEWEST-FIRST -- every accepted dream prepends its block
    (persona/source.py, dream.sh:834-847) -- so the oldest version is whatever
    follows the LAST header in the file. Using the first match would anchor
    every account to its most recent dream and make drift read as ~1.0 forever.

    The header regex must stay in lockstep with ARCHIVE_HEADER in
    persona/source.py: source.py writes what this reads.
    """
    pinned = directory / "personality.anchor.md"
    if pinned.exists():
        return pinned.read_text(encoding="utf-8")

    archive = directory / "personality.archive.md"
    if archive.exists():
        text = archive.read_text(encoding="utf-8")
        matches = list(ARCHIVE_HEADER_RE.finditer(text))
        return text[matches[-1].end() :].strip() if matches else text.strip()

    return (directory / "personality.md").read_text(encoding="utf-8")
```

- [ ] **Step 7: Add an architecture test**

```python
def test_drift_module_does_no_io_beyond_reading_anchor_files() -> None:
    source = (ROOT / "swil_agent" / "dream" / "drift.py").read_text(encoding="utf-8")
    for forbidden in ("import httpx", "import subprocess", "from ..api", "from ..llm"):
        assert forbidden not in source
```

Append it to `tests/unit/test_architecture.py`. The point is to keep the math
callable from a test with no daemon, no network, and no CLI — the property whose
absence made the heredoc bug undetectable.

- [ ] **Step 8: Run everything and commit**

```bash
git add agent/swil_agent/dream agent/swil_agent/models.py agent/tests/unit
git commit -m "feat(agent): drift math and anchor resolution under test

Ports the three routines that were Python-in-heredocs -- cosine, aspect
breach, pairwise variance -- into a module with no I/O, which is the property
that makes them testable at all. Answers the ECHO_VARIANCE_THRESHOLD
calibration question against real vectors."
```

---

## Task 9: `dream/distill.py` — the neutral distiller and the anchor aspect cache

**Files:**
- Create: `agent/swil_agent/dream/distill.py`
- Test: `agent/tests/unit/test_distill.py`

**Interfaces:**
- Consumes: `distill_neutral` (`llm/neutral.py`), `EmbedderClient`, `resolve_anchor_text`.
- Produces: `AspectCards` (pydantic: `values`, `style`, `topic`), `distill_cards(runner, text, model, attempts=3) -> AspectCards | None`, `anchor_aspects(directory, *, runner, embedder, model, prompt_version) -> AspectVectors | None`, `anchor_cache_key(text, prompt_version) -> str`.

**Two invariants that are easy to break and expensive to break.**

1. **The JSON key is `topic`, singular** — while the prompt's own instructions say
   `TOPICS`. Contract `04` §3 flags it: "don't fix it to `topics` or the JSON contract
   breaks". Every consumer uses the singular.
2. **The cache is warm and live.** All 23 accounts have a
   `personality.anchor.aspects.json` (see the contracts README correction). Changing
   the key derivation, the `:v{N}` salt, or the card format invalidates 23 caches and
   forces a roster-wide re-distill — 3 `claude` calls plus 3 `/embed` calls per
   account — on the next round.

- [ ] **Step 1: Write the failing distiller tests**

```python
def test_distill_parses_the_singular_topic_key() -> None:
    runner = ScriptedRunner(['{"values":"a","style":"b","topic":"c"}'])
    cards = distill_cards(runner, "persona text", model="haiku")
    assert cards == AspectCards(values="a", style="b", topic="c")


def test_distill_rejects_the_plural_topics_key() -> None:
    runner = ScriptedRunner(['{"values":"a","style":"b","topics":"c"}'] * 3)
    assert distill_cards(runner, "persona text", model="haiku") is None


def test_distill_extracts_json_embedded_in_prose() -> None:
    runner = ScriptedRunner(['sure!\n{"values":"a","style":"b","topic":"c"}\nhope that helps'])
    assert distill_cards(runner, "t", model="haiku") is not None


def test_distill_rejects_a_blank_aspect_value() -> None:
    runner = ScriptedRunner(['{"values":"a","style":"   ","topic":"c"}'] * 3)
    assert distill_cards(runner, "t", model="haiku") is None


def test_distill_retries_three_times_then_gives_up() -> None:
    runner = ScriptedRunner(["garbage", "garbage", '{"values":"a","style":"b","topic":"c"}'])
    assert distill_cards(runner, "t", model="haiku") is not None
    assert runner.call_count == 3


def test_distill_makes_no_fourth_attempt() -> None:
    runner = ScriptedRunner(["garbage"] * 5)
    assert distill_cards(runner, "t", model="haiku") is None
    assert runner.call_count == 3
```

`test_distill_rejects_the_plural_topics_key` is the guard against someone "fixing"
the prompt's `TOPICS`/`topic` mismatch. Leave a comment saying so.

- [ ] **Step 2: Run them and watch them fail, then implement `distill_cards`**

Run: `cd agent && uv run pytest tests/unit/test_distill.py -v --no-cov`
Expected: FAIL — no `swil_agent.dream.distill`.

```python
_ASPECT_KEYS = ("values", "style", "topic")
_DISTILL_ATTEMPTS = 3

DISTILL_SYSTEM_PROMPT = """..."""  # verbatim from contract 04 §3


def distill_cards(
    runner: Runner, text: str, *, model: str, attempts: int = _DISTILL_ATTEMPTS
) -> AspectCards | None:
    """Distil a personality document into three keyword cards.

    Dispatches through llm/neutral.py, which reaches real Anthropic directly
    and has ZERO imports from the backend registry (design spec §6.5). Routing
    this through the agent's own Backend would let a DeepSeek account be
    measured, and graded, by DeepSeek -- destroying cross-roster comparability.
    tests/unit/test_architecture.py enforces the unreachability.

    Returns None after `attempts` failures. A failure is: no {...} in the
    output, unparseable JSON, a missing key, or any key whose value is not a
    non-empty string after stripping (contract 04 §3).
    """
    request = CompletionRequest(system=DISTILL_SYSTEM_PROMPT, user=f"【人物设定】\n{text}")
    for _ in range(attempts):
        raw = distill_neutral(request, runner, model)
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
    # (contract 04 §3). Do not "correct" it.
    values = {k: obj.get(k) for k in _ASPECT_KEYS}
    if any(not isinstance(v, str) or not v.strip() for v in values.values()):
        return None
    return AspectCards.model_validate(values)
```

`DISTILL_SYSTEM_PROMPT` is the four-line Chinese prompt from contract `04` §3,
copied byte for byte. Its wording is what `ASPECT_PROMPT_VERSION=2` names; changing a
character without bumping the version silently mixes cards distilled under two
different prompts into one similarity series.

- [ ] **Step 3: Write the failing cache tests**

```python
def test_cache_key_is_sha256_of_the_anchor_plus_the_prompt_version() -> None:
    expected = hashlib.sha256("anchor".encode()).hexdigest() + ":v2"
    assert anchor_cache_key("anchor", prompt_version="2") == expected


def test_a_matching_cache_key_skips_the_distiller_entirely(tmp_path: Path) -> None:
    _write_cache(tmp_path, anchor_text="A", vectors=THREE_VECTORS)
    runner = ScriptedRunner([])  # any call raises
    result = anchor_aspects(tmp_path, runner=runner, embedder=None, model="haiku", prompt_version="2")
    assert result == THREE_VECTORS


def test_a_bumped_prompt_version_invalidates_the_cache(tmp_path: Path) -> None:
    _write_cache(tmp_path, anchor_text="A", vectors=THREE_VECTORS, prompt_version="2")
    runner = ScriptedRunner(['{"values":"a","style":"b","topic":"c"}'])
    embedder = FakeEmbedder(THREE_VECTORS)
    anchor_aspects(tmp_path, runner=runner, embedder=embedder, model="haiku", prompt_version="3")
    assert runner.call_count == 1


def test_a_partial_embed_failure_writes_no_cache(tmp_path: Path) -> None:
    runner = ScriptedRunner(['{"values":"a","style":"b","topic":"c"}'])
    embedder = FakeEmbedder(fail_on_call=2)
    assert anchor_aspects(tmp_path, runner=runner, embedder=embedder, model="haiku", prompt_version="2") is None
    assert not (tmp_path / "personality.anchor.aspects.json").exists()


def test_the_real_zenith_cache_loads_without_redistilling() -> None:
    runner = ScriptedRunner([])  # any call raises
    result = anchor_aspects(
        Path("agent/agents/zenith"), runner=runner, embedder=None, model="haiku", prompt_version="2"
    )
    assert result is not None
    assert len(result.values) == 1024
```

The last test is the real proof that the key derivation matches Bash's. If it fails,
Python's key differs from the one 23 warm caches were written under, and the first
Python round would re-distill the entire roster.

- [ ] **Step 4: Implement `anchor_aspects`**

Read path: if the cache file's `.key` equals the freshly computed key, return
`.vectors`. Write path on a miss: distil, embed each of the three cards
**individually** (three separate `/embed` calls, contract `04` §3), and write
`{key, cards, vectors}` only when all three succeed — there is no partial-cache
state. The write is best-effort: a disk failure means re-distilling next time, not a
failed dream.

- [ ] **Step 5: Run everything and commit**

```bash
git add agent/swil_agent/dream/distill.py agent/tests/unit/test_distill.py
git commit -m "feat(agent): neutral aspect distiller and anchor cache

Keeps the singular `topic` JSON key the whole system depends on, and pins the
cache key against zenith's real warm cache -- a key that differs from Bash's
would silently re-distill all 23 accounts on the first Python round."
```

---

## Task 10: `dream/candidate.py` — cooldown, prompt, candidate cleanup

**Files:**
- Create: `agent/swil_agent/dream/candidate.py`
- Test: `agent/tests/unit/test_dream_candidate.py`

**Interfaces:**
- Consumes: `Resources.notifications`, `Backend`, `complete_text`, `collapse_doubled_text`, `Settings`.
- Produces: `CooldownDecision`, `check_cooldown(...)`, `group_memory_digest(notifications) -> str`, `render_dream_prompt(...) -> tuple[str, str]`, `clean_candidate(raw) -> str`, `read_echo_hint(state_dir, name) -> str`.

- [ ] **Step 1: Write the failing cooldown tests**

Contract `03` §1.3, including its two quirks:
- Cooldown applies **only** in auto mode **and** only when a `last_dream_<name>`
  marker already exists. A first-ever dream and any forced dream always proceed.
- "New memories" is a raw `wc -l` delta, not a count of dated entries. The awk that
  counts dated lines is computed and never used — dead code.

```python
def test_force_mode_never_cools_down(state: FakeState) -> None:
    state.set_last_dream(minutes_ago=1, memlines=1000)
    assert check_cooldown(state, "zenith", auto=False, memory_lines=1000).proceed is True


def test_a_first_ever_dream_proceeds(state: FakeState) -> None:
    assert check_cooldown(state, "zenith", auto=True, memory_lines=0).proceed is True


def test_within_cooldown_and_too_few_new_lines_skips(state: FakeState) -> None:
    state.set_last_dream(hours_ago=1, memlines=100)
    decision = check_cooldown(state, "zenith", auto=True, memory_lines=104)
    assert decision.proceed is False
    assert "+4 new memories" in decision.reason


def test_enough_new_lines_overrides_the_cooldown(state: FakeState) -> None:
    state.set_last_dream(hours_ago=1, memlines=100)
    decision = check_cooldown(state, "zenith", auto=True, memory_lines=108)
    assert decision.proceed is True
    assert decision.override is True


def test_an_elapsed_cooldown_proceeds_regardless_of_new_lines(state: FakeState) -> None:
    state.set_last_dream(hours_ago=13, memlines=100)
    assert check_cooldown(state, "zenith", auto=True, memory_lines=100).proceed is True


def test_undated_lines_count_toward_the_override(state: FakeState) -> None:
    # Bash uses a plain `wc -l` delta; the awk that counts DATED lines is dead
    # code (contract 03 §1.3). Any appended line counts -- including the
    # "personality consolidated" housekeeping line the previous dream wrote.
    state.set_last_dream(hours_ago=1, memlines=100)
    assert check_cooldown(state, "zenith", auto=True, memory_lines=108).proceed is True


def test_hours_are_floored_not_rounded(state: FakeState) -> None:
    state.set_last_dream(hours_ago=11.9, memlines=100)
    assert check_cooldown(state, "zenith", auto=True, memory_lines=100).proceed is False
```

The last one pins `floor((now - last) / 3600)`: at 11.9 hours Bash computes 11, which
is `< 12`, so it does not proceed. Integer division here is behaviour.

- [ ] **Step 2: Run them and watch them fail, then implement `check_cooldown`**

Run: `cd agent && uv run pytest tests/unit/test_dream_candidate.py -k cooldown -v --no-cov`

Also implement the marker writes, and preserve their ORDER (contract `03` §4 steps
5–6): the memlines marker is written **before** the "personality consolidated" line is
appended to `memory.md`, so that housekeeping line counts toward the next round's
override tally. Reversing the order changes when every account's next dream fires.
Leave a comment saying so — it looks like a bug and is not one to silently correct
inside a migration.

- [ ] **Step 3: Write the failing group-memory tests**

Contract `03` §2.2: group by actor, weight `likes + comments*2`, take the top 5,
render `- @user（name）：N 条回应 / N 次点赞 / 关注了你` with the trailing `" / "`
stripped. `follows` counts in the render but **not** in the sort weight.

```python
def test_digest_sorts_by_likes_plus_double_comments() -> None:
    notifications = [
        *[_n("alpha", "like")] * 5,
        *[_n("beta", "comment")] * 3,
    ]
    assert group_memory_digest(notifications).splitlines()[0].startswith("- @beta")


def test_follows_do_not_affect_the_sort_weight() -> None:
    notifications = [*[_n("alpha", "follow")] * 9, _n("beta", "like")]
    assert group_memory_digest(notifications).splitlines()[0].startswith("- @beta")


def test_reply_and_mention_count_as_comments() -> None:
    digest = group_memory_digest([_n("alpha", "reply"), _n("alpha", "mention")])
    assert "2 条回应" in digest


def test_digest_takes_at_most_five_users() -> None:
    notifications = [_n(f"user{i}", "like") for i in range(9)]
    assert len(group_memory_digest(notifications).splitlines()) == 5


def test_digest_strips_the_trailing_separator() -> None:
    assert group_memory_digest([_n("alpha", "like")]) == "- @alpha（Alpha）：1 次点赞"


def test_an_empty_notification_list_yields_an_empty_digest() -> None:
    assert group_memory_digest([]) == ""
```

The empty case matters downstream: the prompt omits the entire group-memory section —
heading, separator and all — when the digest is empty.

- [ ] **Step 4: Write the failing prompt tests**

Contract `03` §2.4. The system prompt is **100% static** (Bash uses a quoted heredoc,
so nothing interpolates). The user prompt has two `${var:+...}` blocks that vanish
whole.

```python
def test_the_system_prompt_is_static() -> None:
    a = render_dream_prompt(persona_text="A", recent_memory="m", archive_tail="t")[0]
    b = render_dream_prompt(persona_text="B", recent_memory="n", archive_tail="u")[0]
    assert a == b


def test_the_group_memory_section_vanishes_when_empty() -> None:
    _, user = render_dream_prompt(persona_text="p", recent_memory="m", archive_tail="t")
    assert "最近与你对话过的人" not in user


def test_the_echo_hint_section_vanishes_when_empty() -> None:
    _, user = render_dream_prompt(persona_text="p", recent_memory="m", archive_tail="t")
    assert "来自上一个梦的提醒" not in user


def test_both_optional_sections_appear_when_populated() -> None:
    _, user = render_dream_prompt(
        persona_text="p", recent_memory="m", archive_tail="t",
        group_memory="- @vex（Vex）：1 次点赞", echo_hint="换个话题",
    )
    assert "最近与你对话过的人" in user
    assert "来自上一个梦的提醒" in user


def test_the_archive_tail_placeholder_is_used_when_there_is_no_archive() -> None:
    _, user = render_dream_prompt(persona_text="p", recent_memory="m", archive_tail="")
    assert "(尚无历史归档)" in user
```

Note the memory windows differ between the two paths and both are behaviour: the act
prompt uses `tail -20` of `memory.md`, the dream prompt uses `tail -60` plus
`tail -20` of `memory.archive.md` (contracts `01` §2d and `03` §2.1).

- [ ] **Step 5: Implement the prompts**

Copy both templates byte for byte from contract `03` §2.4. The system prompt's five
numbered output requirements are what keep the structural validators satisfiable —
in particular requirement 2 (the five bullets that must round-trip) and requirement 3
(the recognisable rhythm phrasings). Paraphrasing any of it raises the rejection rate
without anyone knowing why.

- [ ] **Step 6: Write the failing candidate-cleanup tests**

Contract `03` §3, in order: `collapse_doubled_text` (already applied inside
`complete_text`), then strip a leading/trailing ` ```markdown ` / ` ``` ` fence, then
drop everything before the first line starting with `# `.

```python
def test_cleanup_strips_a_markdown_fence() -> None:
    assert clean_candidate("```markdown\n# Name\nbody\n```") == "# Name\nbody"


def test_cleanup_drops_preamble_before_the_first_heading() -> None:
    assert clean_candidate("Sure, here you go:\n\n# Name\nbody").startswith("# Name")


def test_cleanup_keeps_later_hash_headings() -> None:
    assert "## 发帖节律" in clean_candidate("# Name\n## 发帖节律\n60% 概率选择 post")


def test_cleanup_of_an_empty_response_is_empty() -> None:
    assert clean_candidate("   \n\n  ") == ""
```

The third test guards the awk translation: the rule is "drop everything before the
FIRST `# ` line", not "keep only `# ` lines".

- [ ] **Step 7: Run everything and commit**

```bash
git add agent/swil_agent/dream/candidate.py agent/tests/unit/test_dream_candidate.py
git commit -m "feat(agent): dream cooldown, group memory digest, and prompt

Reproduces the wc -l delta the cooldown override actually uses (the dated-line
awk beside it is dead code), the marker-before-append ordering that makes the
housekeeping line self-count, and the two prompt sections that vanish whole."
```

---

## Task 11: `dream/gate.py` — validators plus drift produce a verdict

**Files:**
- Create: `agent/swil_agent/dream/gate.py`
- Test: `agent/tests/unit/test_gate.py`

**Interfaces:**
- Consumes: `validate_candidate` (`persona/validators.py`, Plan 1), Tasks 8 and 9, `EmbedderClient`.
- Produces: `evaluate_candidate(original, candidate, *, directory, embedder, runner, settings) -> DreamVerdict`.

**Order is fixed** (contract `03` §1.4 and `04` §5): structural validators run first
and are hard rejects independent of `DRIFT_MODE`; only a structurally valid candidate
reaches the drift gate.

- [ ] **Step 1: Write the failing structural-precedence test**

```python
def test_a_structural_failure_short_circuits_before_any_embedding() -> None:
    embedder = FakeEmbedder(fail_always=True)  # any call raises
    verdict = evaluate_candidate(ORIGINAL, candidate_with_changed_username(), embedder=embedder, ...)
    assert verdict.accepted is False
    assert verdict.reason == "Username drift"
    assert embedder.calls == 0
```

`embedder.calls == 0` is the assertion doing the work: it proves the ordering rather
than just the outcome.

- [ ] **Step 2: Write the failing mode tests**

```python
def test_scalar_mode_never_computes_aspects() -> None:
    runner = ScriptedRunner([])  # any distill call raises
    verdict = evaluate_candidate(..., drift_mode="scalar", runner=runner)
    assert verdict.sims is None


def test_shadow_mode_computes_aspects_but_gates_on_the_scalar() -> None:
    # sims all breach, scalar sim is comfortably above threshold
    verdict = evaluate_candidate(..., drift_mode="shadow", scalar_sim=0.95, aspect_sims=ALL_LOW)
    assert verdict.accepted is True
    assert verdict.sims == ALL_LOW


def test_aspect_mode_rejects_on_a_single_breach() -> None:
    verdict = evaluate_candidate(..., drift_mode="aspect", aspect_sims=ONLY_STYLE_LOW)
    assert verdict.accepted is False
    assert verdict.breached == ["style"]


def test_aspect_mode_accepts_when_nothing_breaches() -> None:
    verdict = evaluate_candidate(..., drift_mode="aspect", aspect_sims=ALL_HIGH)
    assert verdict.accepted is True
```

- [ ] **Step 3: Write the failing fail-open tests**

Contract `04` §5. Three distinct paths, each with its own log line:

```python
def test_a_failed_distill_falls_back_to_the_scalar_gate() -> None:
    verdict = evaluate_candidate(..., drift_mode="aspect", distill_returns=None, scalar_sim=0.95)
    assert verdict.accepted is True
    assert "falling back to scalar drift" in verdict.reason


def test_an_unreachable_embedder_skips_the_drift_check_entirely() -> None:
    verdict = evaluate_candidate(..., embedder=FakeEmbedder(fail_always=True))
    assert verdict.accepted is True
    assert "embedder unreachable" in verdict.reason


def test_an_unreachable_embedder_still_enforces_the_structural_validators() -> None:
    verdict = evaluate_candidate(
        ORIGINAL, candidate_missing_rhythm_section(), embedder=FakeEmbedder(fail_always=True)
    )
    assert verdict.accepted is False
```

The third is the invariant CLAUDE.md states plainly: when the embedder is down the
drift gate fails open, but the structural validators remain the hard floor. A port
that wrapped the whole gate in one try/except would lose that and let a malformed
personality.md onto disk during an embedder outage.

- [ ] **Step 4: Implement `evaluate_candidate`**

```python
def evaluate_candidate(...) -> DreamVerdict:
    """Structural validators, then the drift gate.

    ORDER IS THE CONTRACT. The six structural checks are hard rejects that run
    first and do not depend on DRIFT_MODE, the embedder, or the distiller
    (contract 03 §1.4). Only a structurally valid candidate is worth embedding.

    Every drift-side failure FAILS OPEN, and each one is a distinct, logged
    decision rather than a silent pass:

      distill/embed failed  -> fall back to the scalar gate
      scalar embed failed   -> skip the drift check, accept
      no anchor             -> not reachable; resolve_anchor_text always
                               returns something, falling back to the current
                               personality (first-dream case)

    What never fails open: the structural validators. When the embedder is
    down they are the only floor left, and losing them would let a candidate
    with a mangled Username bullet reach disk.
    """
```

Follow contract `04` §5's decision flow exactly: always compute the scalar similarity
first (all three modes use it — as the gate, as the shadow baseline, or as the
aspect-mode fallback); compute aspects only when `drift_mode != "scalar"`; emit the
`SHADOW-OBS` line in shadow mode regardless of the eventual accept/reject, so
calibration data accumulates from rejected dreams too.

The `DRIFT_MODE` default deserves a note in the docstring. `dream.sh:62` defaults to
`scalar`; `Settings.drift_mode` defaults to `aspect` because `agent/.env` sets
`DRIFT_MODE=aspect` and `load_settings` reads that file. The Python default matches
the **deployed** value, not the script's bare fallback — deliberately, since the
deployed value is the one the in-flight experiment has been running under. Add a test
asserting `load_settings()` on the real `agent/.env` yields `aspect`, so a future
`.env` edit cannot change the gate silently.

- [ ] **Step 5: Run everything and commit**

```bash
git add agent/swil_agent/dream/gate.py agent/tests/unit/test_gate.py
git commit -m "feat(agent): dream gate over validators and per-aspect drift

Structural validators short-circuit before any embedding, so they stay the
hard floor when the embedder is down. Each drift-side fail-open is a distinct
logged decision instead of a silent pass."
```

---

## Task 12: `dream/round.py` — compose the dream path

**Files:**
- Create: `agent/swil_agent/dream/round.py`
- Test: `agent/tests/unit/test_dream_round.py`

**Interfaces:**
- Consumes: Tasks 2, 8–11, `GitPersonaSource.archive_and_write`, `Resources.create_snapshot`, `EmbedderClient`.
- Produces: `DreamResult`, `run_dream(...) -> DreamResult`, `build_snapshot_payload(...)`.

- [ ] **Step 1: Write the failing write-ordering test**

Contract `03` §4 fixes the order, and each step depends on the previous one's state:

1. compute the diff narrative **while both files still exist separately**
2. prepend the old version to `personality.archive.md`
3. move the candidate over `personality.md`
4. write `last_dream_<name>` (epoch seconds)
5. write `last_dream_memlines_<name>` (line count **before** step 6)
6. append `<date> | dream | personality consolidated` to `memory.md`
7. upload the snapshot — **after** `personality.md` is already live

```python
def test_the_write_sequence_matches_bash(recorder: OrderRecorder) -> None:
    run_dream(..., recorder=recorder)
    assert recorder.order == [
        "diff_narrative",
        "archive_prepend",
        "personality_write",
        "marker_last_dream",
        "marker_memlines",
        "memory_append",
        "snapshot_upload",
    ]


def test_the_memlines_marker_is_written_before_the_memory_append() -> None:
    result = run_dream(..., memory_lines_before=100)
    assert result.recorded_memlines == 100  # not 101


def test_a_rejected_dream_touches_nothing(tmp_path: Path) -> None:
    before = _snapshot_dir(tmp_path)
    run_dream(..., verdict=REJECTED)
    assert _snapshot_dir(tmp_path) == before
```

The middle test is the quirk from contract `03` §4: because the marker is written
first, the housekeeping line self-counts toward the next round's override tally.
Recording 101 there would change when every account's next dream fires.

- [ ] **Step 2: Write the failing snapshot-failure test**

Contract `03` §5: a snapshot failure is a WARN. It does **not** roll back the
personality write, which has already committed.

```python
def test_a_snapshot_failure_does_not_roll_back_the_personality_write(tmp_path: Path) -> None:
    result = run_dream(..., snapshot_raises=WriteNotVerifiedError("rejected"))
    assert result.accepted is True
    assert result.snapshot_ok is False
    assert (tmp_path / "personality.md").read_text(encoding="utf-8") == CANDIDATE


def test_the_snapshot_failure_reason_comes_from_the_error_not_a_guess() -> None:
    result = run_dream(..., snapshot_raises=WriteNotVerifiedError("no api_key.txt"))
    assert "no api_key.txt" in (result.snapshot_reason or "")
```

The second one preserves a lesson Bash already learned the hard way: it quotes
snapshot.sh's own last stderr line rather than a hardcoded "(server or embedder
unreachable)", because that guess once sent investigators chasing the wrong systems
when the real cause — a missing `api_key.txt` — had already been printed.

- [ ] **Step 3: Write the failing snapshot-payload test**

Contract `03` §5. `capturedAt` is UTC ISO8601 with a `Z`; `excerpt` is the first 280
**characters** (not bytes) with newlines flattened; `archivePath` is relative to
`agent/`.

```python
def test_snapshot_payload_shape() -> None:
    payload = build_snapshot_payload(
        text="x" * 400, directory=Path("/agent/agents/zenith"), agent_root=Path("/agent"),
        embedding=[0.1] * 1024, captured_at=datetime(2026, 8, 17, 12, tzinfo=UTC),
    )
    assert payload["snapshotType"] == "dream"
    assert payload["capturedAt"] == "2026-08-17T12:00:00Z"
    assert payload["archivePath"] == "agents/zenith/personality.md"
    assert len(payload["excerpt"]) == 280
    assert payload["contentHash"] == hashlib.sha256(("x" * 400).encode()).hexdigest()


def test_the_excerpt_counts_characters_not_bytes() -> None:
    payload = build_snapshot_payload(text="中" * 400, ...)
    assert len(payload["excerpt"]) == 280


def test_optional_fields_are_omitted_when_absent() -> None:
    payload = build_snapshot_payload(..., narrative="", aspect_drift=None)
    assert "diffNarrative" not in payload
    assert "aspectDrift" not in payload
```

`test_the_excerpt_counts_characters_not_bytes` guards a real historical bug: Bash's
first attempt used `head -c 280`, which split a multibyte CJK character and crashed
the downstream `jq --arg` under `set -e`. Python slicing is codepoint-based and gets
this right by default — the test exists so a future "optimisation" to bytes fails
loudly.

- [ ] **Step 4: Implement `run_dream`**

Guard the whole body with `FileLock(dream_lock_path(agent_root, name))` (Task 2).
The lock's release-on-exception behaviour is what stops the accepted-dream orphan
lock — under Bash every accepted dream exits 141 after "snapshot uploaded" and leaves
`dream_lock_<name>` behind, which then makes the NEXT dream SKIP.

Echo detection runs last, after the snapshot, and only when `settings.echo_detect` is
true — which it is not by default, and must not become so in this plan. The threshold
is uncalibrated (0.04 against a measured 0.001–0.011 range), so enabling it flags
every account on every dream and would confound the topic aspect of the in-flight
experiment.

- [ ] **Step 5: Run everything and commit**

```bash
git add agent/swil_agent/dream/round.py agent/tests/unit/test_dream_round.py
git commit -m "feat(agent): compose the dream round

Preserves Bash's write ordering, including the memlines marker landing before
the housekeeping memory line so it self-counts toward the next override. The
dream lock releases on every exit path, which is the orphan-lock class of
defect that has needed a manual sweep after every round."
```

---

## Task 13: `cli.py` — entrypoints, and the docs that point at them

**Files:**
- Create: `agent/swil_agent/cli.py`
- Modify: `CLAUDE.md`, `docs/12-handoff.md`
- Test: `agent/tests/unit/test_cli.py`

**Interfaces:**
- Consumes: everything above.
- Produces: `app` (typer), commands `act`, `dream`, `version`. `pyproject.toml` already declares `swil-agent = "swil_agent.cli:app"`.

- [ ] **Step 1: Write the failing CLI tests**

Use `typer.testing.CliRunner`.

```python
def test_act_dry_run_executes_nothing_and_writes_nothing(tmp_agent: Path) -> None:
    result = runner.invoke(app, ["act", "zenith", "--dry-run"])
    assert result.exit_code == 0
    assert "would execute" in result.stdout
    assert _memory_unchanged(tmp_agent)


def test_act_reports_the_outcome_name(tmp_agent: Path) -> None:
    result = runner.invoke(app, ["act", "zenith", "--dry-run"])
    assert "planner_empty" in result.stdout or "landed" in result.stdout


def test_an_unknown_account_exits_66(tmp_agent: Path) -> None:
    result = runner.invoke(app, ["act", "nosuchagent"])
    assert result.exit_code == 66


def test_a_held_lock_exits_75(tmp_agent: Path) -> None:
    _hold_lock(tmp_agent, "zenith")
    assert runner.invoke(app, ["act", "zenith"]).exit_code == 75


def test_dream_honours_auto_cooldown(tmp_agent: Path) -> None:
    _set_last_dream(tmp_agent, "zenith", hours_ago=1)
    result = runner.invoke(app, ["dream", "zenith", "--auto"])
    assert "cooldown" in result.stdout
```

Exit codes 66 and 75 keep the Bash contract (contract `01` §1) so `cycle-one.sh` and
the heartbeat can call either runtime during the canary. Spec §7.1's typed outcomes
are the internal representation; the process exit code stays the external one.

- [ ] **Step 2: Run them and watch them fail, then implement `cli.py`**

Run: `cd agent && uv run pytest tests/unit/test_cli.py -v --no-cov`
Expected: FAIL — no `swil_agent.cli`.

```python
"""CLI entrypoints, argument-compatible with the Bash scripts where they overlap.

Exit codes are deliberately the Bash ones (66 = no such account, 75 = no
action ran) so cycle-one.sh and the heartbeat can invoke either runtime during
the canary stage without knowing which they got. The typed ActOutcome is the
internal representation; the process exit code is the external contract.
"""

app = typer.Typer(add_completion=False, help="Swil Social agent runtime")


@app.command()
def act(
    name: str,
    dry_run: bool = typer.Option(False, "--dry-run", help="Plan only; execute and write nothing."),
    budget: int = typer.Option(5, "--budget"),
    seed: int | None = typer.Option(None, "--seed", help="Seed the rhythm roll for reproducibility."),
) -> None:
    ...


@app.command()
def dream(
    name: str,
    auto: bool = typer.Option(False, "--auto", help="Honour the 12h cooldown."),
) -> None:
    ...
```

`--seed` exists because the rhythm roll makes the act path nondeterministic before
the LLM is even called (spec §6.3). Without it the shadow round cannot compare
Python's rhythm verdict against Bash's on a probabilistic account.

- [ ] **Step 3: Wire the composition root**

One function that builds the object graph from `Settings` and a persona name:
resolve the directory, load the persona, `resolve_auth`, build `ApiClient` +
`Resources`, `build_backend`, `EmbedderClient`, `GitPersonaSource`. Keep it in
`cli.py` — it is the only place allowed to know about all of them at once, and
keeping it there is what lets every module below stay unit-testable.

- [ ] **Step 4: Update the docs**

In `CLAUDE.md`, under the activity-cycle section, add the Python entrypoints beside
the Bash ones and state plainly which is authoritative today:

```markdown
| `uv run --project agent swil-agent act <name>` | one account | Python port of `auto-run.sh`'s act path. `--dry-run` plans without executing — this is the shadow-round mode. |
| `uv run --project agent swil-agent dream <name> [--auto]` | one account | Python port of `dream.sh`. |

**Bash is still the runtime of record.** The Python entrypoints exist for the
shadow round and the canary (migration spec §10 stages 3–4). A full round is
still `cycle-one.sh`; do not point the heartbeat at the Python CLI until
stage 5.
```

In `docs/12-handoff.md`, record: Plan 2 complete, what runs, what does not
(`graph/`, `analysis/`, leases, checkpointing — all Plan 3), and the two open
questions this plan deliberately left: the guardrail stage-ordering artefact and the
`landed == 0` dream policy.

- [ ] **Step 5: Run the full pipeline and commit**

Run from the repo root: `npm run ci:check`
Expected: 13/13 green.

```bash
git add agent/swil_agent/cli.py agent/tests/unit/test_cli.py CLAUDE.md docs/12-handoff.md
git commit -m "feat(agent): swil-agent CLI with act, dream, and --dry-run

Keeps the Bash exit codes (66/75) so cycle-one.sh can invoke either runtime
during the canary. --dry-run plans without executing, which is the shadow-round
mode the cutover depends on."
```

---

## Self-review

**Spec coverage.** Against the design spec's §5.1 package layout, this plan delivers
`act/` (context, planner, guardrails, executor), `dream/` (candidate, drift, gate,
snapshot — folded into `round.py`), `embedder/` (client, guard), and `cli.py`. It does
NOT deliver `graph/` (state, cycle, checkpoint, leases) or `analysis/` (rule_check,
behavior_snapshot, population_metric, summary). Those are Plan 3, and the spec's §10
stage 2 names them alongside this work — the split is deliberate: everything here sits
below `graph/` in the dependency order, so it is unit-testable without a graph runtime,
and it ends at a `--dry-run` capable CLI, which is the shadow round (§9.4, stage 3).

Behaviour contracts §6.1–6.8: §6.1 rhythm parser and §6.4 validators shipped in Plan 1;
§6.2 asymmetry is Task 5 stage 3 plus Task 4's prompt-only `must_post`; §6.3 injectable
RNG is Task 7 and the CLI's `--seed`; §6.5 neutral ruler is Task 9; §6.6 degradations
are Task 6; §6.7 dual auth is Task 1; §6.8 codex allow-list is Task 5 and `allowed_for`
in Task 7. Deliberate changes §7.1–7.7: §7.1 Task 7, §7.2 Task 6, §7.3 **not this plan**
(Task 2 ships Bash-compatible locks as a coexistence measure and says so), §7.4 achieved
by construction (no `active` file anywhere), §7.5 Task 5, §7.6 Task 6, §7.7 Task 3.

**Gaps I am recording rather than closing.** Structured logging (§7.6) is specified as
"emit both a structured event and the existing human-readable line". This plan carries
the human-readable formats through the executor and round tasks but does not build a
logging module — the structured-event sink belongs with the graph's node events in
Plan 3, and building half of it here would mean building it twice. Flag it in the Plan 3
handoff rather than leaving it implicit.

**Type consistency.** `ActContext`, `ActResult`, `LabEvent`, `AspectCards`,
`AspectThresholds`, `GuardrailResult`, `CooldownDecision` and `DreamResult` are all
introduced with their fields spelled out, and every task that consumes one names the
task that produced it. `Plan`, `Action`, `VetoedAction`, `ActionResult`, `ActOutcome`,
`RhythmPolicy`, `RhythmDecision`, `Persona`, `AspectSims` and `DreamVerdict` already
exist from Plan 1 and are used with their existing shapes.

**Two rulings recorded in the plan text, so the implementer does not re-litigate them:**

1. **Guardrail stage ordering is reproduced, not fixed** (Task 5 step 2). It empties a
   `[post, nothing]` plan under `no_post`. Reordering would register as divergence on
   every rhythm-vetoed round of the shadow comparison, and the harm the ordering used
   to cause is already gone under §7.1.
2. **`landed == 0` no longer denies the dream** (Task 7 step 2). Bash skips the dream;
   §7.1 says only `BACKEND_UNAVAILABLE` and `OFFLINE` may. Following the spec, logging
   it at FAIL level with the old wording, and recording it as a change point in the
   drift series.
