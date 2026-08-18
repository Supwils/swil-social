"""Shared `Runner`- and `Backend`-protocol test doubles.

Single home for these so `test_backends.py`, `test_embedder.py`, and any later
task's tests (act/dream) import the same fakes instead of each hand-rolling
one. All classes conform structurally to `swil_agent.llm.base.Runner` /
`swil_agent.llm.base.Backend`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from swil_agent.api.client import ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.api.resources import WriteNotVerifiedError
from swil_agent.llm.base import BackendUnavailableError, CompletionRequest


@dataclass(frozen=True)
class RunnerCall:
    """One recorded invocation of `Runner.run`."""

    argv: list[str]
    stdin: str | None
    env: dict[str, str] | None
    timeout: float


class RecordingRunner:
    """Records every call and always returns the same fixed string."""

    def __init__(self, output: str = "ok") -> None:
        self.output = output
        self.calls: list[RunnerCall] = []

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
    ) -> str:
        self.calls.append(RunnerCall(argv=list(argv), stdin=stdin, env=env, timeout=timeout))
        return self.output


class ScriptedRunner:
    """Returns queued responses in call order.

    Raises `RuntimeError` if called more times than it has scripted
    responses -- a test that over-calls this fake is exercising a path the
    test author did not account for, and a silent extra "ok" would mask that.
    """

    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)
        self.calls: list[RunnerCall] = []
        self.call_count = 0

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
    ) -> str:
        self.calls.append(RunnerCall(argv=list(argv), stdin=stdin, env=env, timeout=timeout))
        if self.call_count >= len(self._responses):
            raise RuntimeError(
                f"ScriptedRunner called {self.call_count + 1} time(s) but only "
                f"{len(self._responses)} response(s) were scripted"
            )
        response = self._responses[self.call_count]
        self.call_count += 1
        return response


class StubBackend:
    """A `Backend` double that returns a fixed response and records requests.

    Conforms structurally to `swil_agent.llm.base.Backend`. Used by planner
    tests to inspect what `plan_round` sends as the system/user prompt
    without invoking a real CLI.
    """

    name = "stub"

    def __init__(self, response: str) -> None:
        self.response = response
        self.calls: list[CompletionRequest] = []
        self.last: CompletionRequest | None = None

    def complete(self, req: CompletionRequest) -> str:
        self.calls.append(req)
        self.last = req
        return self.response


class SilentBackend:
    """Mirrors a real backend producing no output at all.

    Every concrete `Backend` (`ClaudeCLIBackend`, `CodexCLIBackend`,
    `DeepSeekCLIBackend`) signals "nothing came back" by raising
    `BackendUnavailableError` from `complete`, not by returning an empty
    string -- see `llm/base.py`. A fake that just returned `""` would not be
    exercising the path a real backend actually takes.
    """

    name = "silent"

    def complete(self, req: CompletionRequest) -> str:
        raise BackendUnavailableError("silent backend produced no output")


class ExplodingBackend:
    """Raises a plain (non-`BackendUnavailableError`) exception from
    `complete` -- unlike `SilentBackend`, whose exception `plan_round`
    catches and turns into `None`. `plan_round` only ever catches
    `BackendUnavailableError` (see `act/planner.py`), so this is what a
    genuinely broken step looks like from `run_act`'s point of view: used to
    prove a mid-round failure still propagates out of `run_act` and still
    releases the account lock (`act/round.py`, task 7).
    """

    name = "exploding"

    def complete(self, req: CompletionRequest) -> str:
        raise RuntimeError("exploding backend: boom")


# ── FakeResources (act/executor.py, task 6; extended for act/round.py, task 7) ──


@dataclass(frozen=True)
class RecordedPost:
    """One `Resources.create_post` call `FakeResources` captured.

    `image_topic` is NOT a real `create_post` parameter — the real method
    only ever sees `image: tuple[str, bytes] | None`, a (filename, bytes)
    pair already resolved from a topic string by an `ImageFetcher`. This
    field is derived from that pair's filename half (`image[0]`) purely so
    executor tests can assert "the topic string that reached the image
    fetcher was never run through `collapse_doubled_text`" without adding a
    field to the real API surface. Tests that care about this pin their own
    fake `ImageFetcher` to return `(topic, ...)` verbatim, making
    `image_topic` equal the original topic exactly when nothing mangled it
    in transit.
    """

    text: str
    board_id: str | None
    image_topic: str | None
    echo_of: str | None


@dataclass(frozen=True)
class RecordedComment:
    post_id: str
    text: str
    parent_id: str | None


@dataclass(frozen=True)
class RecordedDM:
    username: str
    text: str


class FakeResources:
    """Records every write call `execute_action` (act/executor.py) attempts.

    Duck-types `swil_agent.api.resources.Resources`'s write surface rather
    than subclassing it — `[tool.mypy] files = ["swil_agent"]` in
    pyproject.toml never type-checks `tests/`, so there is nothing to gain
    from a real subclass, only a matching call shape at runtime.

    Failure knobs, each `None`/`False` by default (every call succeeds):
      - `fail_first_comment`: the FIRST `create_comment` call raises an
        `ApiError` shaped like the server's real "parentId does not belong
        to postId" 404 (`comments.service.ts`), regardless of whether a
        `parent_id` was given; every later call succeeds. This is what lets
        one instance drive both the comment-retry-succeeds and the
        plain-top-level-failure tests from the same fake.
      - `comment_returns_no_id`: EVERY `create_comment` call raises
        `WriteNotVerifiedError` — the codex silent-fail shape (a 2xx with no
        id) this task exists to close off. Also useful for exercising "the
        retry attempt itself fails".
      - `post_raises` / `like_raises` / `dm_raises`: if set, the
        corresponding method raises this exact exception on every call.
      - `follow_raises`: if set, `.follow()` raises this exact exception
        instead of recording a follow.
      - `post_id`: if set, `create_post` always returns this exact string
        instead of the auto-incrementing `f"post-{n}"` — added for
        `act/round.py`'s memory-line tests, which pin an exact resource id
        (`task-7-brief.md`'s own literal `"newpost0000000000000000"`) into
        the expected memory.md line and need a deterministic id to match it
        against, not merely a stable-shaped one.

    Extended for `act/round.py` (task 7) with `build_context`'s READ surface
    (`feed_global`, `notifications`, `get_post`, `get_comments`, `contacts`,
    `conversations`) — duck-typed identically to the local `FakeResources` in
    `test_act_context.py` (that file is untouched; this is a parallel,
    merged copy so a single instance can drive a full `run_act` round, which
    needs both halves of `Resources` at once). Every read method returns an
    empty/default result unless populated via the plain public attributes
    below (`recommended`, `latest`, `notification_items`, `contacts_result`,
    `conversation_items`, `posts`, `thread_comments`), or raises `ApiError`
    for a name passed to `fail()` / a post id passed to `fail_post()`. Read
    calls are NOT recorded into `self.calls` — that list stays scoped to
    writes, matching its existing use by `test_missing_fields_skip_...`.
    """

    def __init__(
        self,
        *,
        fail_first_comment: bool = False,
        comment_returns_no_id: bool = False,
        post_raises: ApiError | WriteNotVerifiedError | None = None,
        like_raises: ApiError | WriteNotVerifiedError | None = None,
        dm_raises: ApiError | WriteNotVerifiedError | None = None,
        follow_raises: ApiError | WriteNotVerifiedError | None = None,
        post_id: str | None = None,
    ) -> None:
        self._fail_first_comment = fail_first_comment
        self._comment_returns_no_id = comment_returns_no_id
        self._post_raises = post_raises
        self._like_raises = like_raises
        self._dm_raises = dm_raises
        self._follow_raises = follow_raises
        self._post_id_override = post_id
        self._comment_call_count = 0

        self.calls: list[str] = []
        self.created_posts: list[RecordedPost] = []
        self.comments: list[RecordedComment] = []
        self.liked: list[str] = []
        self.followed: list[str] = []
        self.dms: list[RecordedDM] = []
        self.lab_events: list[LabEvent] = []

        # Read surface (act/context.py's build_context) — see class
        # docstring's "Extended for act/round.py" note.
        self._fail: set[str] = set()
        self._fail_posts: set[str] = set()
        self.recommended: list[dict[str, Any]] = []
        self.latest: list[dict[str, Any]] = []
        self.notification_items: list[dict[str, Any]] = []
        self.contacts_result: list[str] = []
        self.conversation_items: list[dict[str, Any]] = []
        self.posts: dict[str, dict[str, Any]] = {}
        self.thread_comments: dict[str, list[dict[str, Any]]] = {}

    def fail(self, name: str) -> None:
        """Make the named read call raise `ApiError`. `name` is one of
        `"feed_global_recommended"`, `"feed_global_latest"`,
        `"notifications"`, `"contacts"`, `"conversations"` — matching
        `test_act_context.py`'s local fake exactly."""
        self._fail.add(name)

    def fail_post(self, post_id: str) -> None:
        """Make `get_post`/`get_comments` raise `ApiError` for this one id."""
        self._fail_posts.add(post_id)

    def feed_global(self, limit: int, sort: str) -> list[dict[str, Any]]:
        if f"feed_global_{sort}" in self._fail:
            raise ApiError(500, "boom", None)
        return self.recommended if sort == "recommended" else self.latest

    def notifications(self, limit: int, unread_only: bool = True) -> list[dict[str, Any]]:
        if "notifications" in self._fail:
            raise ApiError(500, "boom", None)
        return self.notification_items

    def get_post(self, post_id: str) -> dict[str, Any]:
        if post_id in self._fail_posts:
            raise ApiError(500, "boom", None)
        return self.posts.get(post_id, {"id": post_id})

    def get_comments(self, post_id: str, limit: int = 6) -> list[dict[str, Any]]:
        if post_id in self._fail_posts:
            raise ApiError(500, "boom", None)
        return self.thread_comments.get(post_id, [])

    def contacts(self) -> list[str]:
        if "contacts" in self._fail:
            raise ApiError(500, "boom", None)
        return self.contacts_result

    def conversations(self, limit: int = 6) -> list[dict[str, Any]]:
        if "conversations" in self._fail:
            raise ApiError(500, "boom", None)
        return self.conversation_items

    def create_post(
        self,
        text: str,
        board_id: str | None = None,
        image: tuple[str, bytes] | None = None,
        echo_of: str | None = None,
    ) -> str:
        self.calls.append("create_post")
        self.created_posts.append(
            RecordedPost(
                text=text,
                board_id=board_id,
                image_topic=image[0] if image is not None else None,
                echo_of=echo_of,
            )
        )
        if self._post_raises is not None:
            raise self._post_raises
        if self._post_id_override is not None:
            return self._post_id_override
        return f"post-{len(self.created_posts)}"

    def create_comment(self, post_id: str, text: str, parent_id: str | None = None) -> str:
        self.calls.append("create_comment")
        self.comments.append(RecordedComment(post_id=post_id, text=text, parent_id=parent_id))
        self._comment_call_count += 1
        if self._comment_returns_no_id:
            raise WriteNotVerifiedError(
                f"comment created no id; response={{}} (call {self._comment_call_count})"
            )
        if self._fail_first_comment and self._comment_call_count == 1:
            raise ApiError(
                404,
                '{"error":{"code":"NOT_FOUND","message":"Parent comment not found"}}',
                "NOT_FOUND",
            )
        return f"comment-{len(self.comments)}"

    def like_post(self, post_id: str) -> None:
        self.calls.append("like_post")
        if self._like_raises is not None:
            raise self._like_raises
        self.liked.append(post_id)

    def follow(self, username: str) -> None:
        self.calls.append("follow")
        if self._follow_raises is not None:
            raise self._follow_raises
        self.followed.append(username)

    def send_dm(self, username: str, text: str) -> str:
        self.calls.append("send_dm")
        if self._dm_raises is not None:
            raise self._dm_raises
        self.dms.append(RecordedDM(username=username, text=text))
        return f"dm-{len(self.dms)}"

    def lab_event(self, username: str, event: LabEvent) -> None:
        self.lab_events.append(event)
