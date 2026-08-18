"""Typed endpoint methods with write verification.

Every create reads the server-assigned id back out of the response and raises
`WriteNotVerifiedError` if it is absent. `swil.sh` did not do this: `like`
piped the response straight to `jq .` and inspected nothing (its reported
exit status was `jq`'s, not curl's — see agent/scripts/swil.sh line 503), and
`comment` extracted `.data.comment.id` only to write a log line, never
failing when it was empty (line 494). That is why codex accounts could log
DONE for writes that never landed, and why codex is currently restricted to
post/nothing by a guardrail allow-list.

Response shapes below were read out of `server/src/` directly (not assumed
from the task brief, which guessed wrong on `send_dm` and on the create_post
multipart field name) and are cited with file:line evidence in each method's
docstring.
"""

from __future__ import annotations

from typing import Any

from swil_agent.api.client import ApiClient, ApiError
from swil_agent.api.dto import LabEvent


class WriteNotVerifiedError(RuntimeError):
    """A 2xx response carried no server-assigned id, or no provable write
    state, for an operation that is supposed to have one.

    This is the class of failure `swil.sh` could not detect: a parseable,
    even well-formed, JSON envelope that nonetheless proves nothing was
    created or changed.
    """


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


def _nested_id(payload: dict[str, Any], *path: str) -> str | None:
    """Walk `path` through nested dicts and return the value only if it is a
    non-empty string. Any missing key, wrong type, or empty string along the
    way yields None rather than raising — the caller turns that into a loud
    `WriteNotVerifiedError` instead of an opaque KeyError/TypeError."""
    node: Any = payload
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node if isinstance(node, str) and node else None


class Resources:
    def __init__(self, client: ApiClient) -> None:
        self._client = client

    def me(self) -> dict[str, Any]:
        """GET /auth/me — NOT `/me` and NOT `/users/me`.

        `authRouter.get('/me', requireUser, asyncHandler(ctrl.me))`
        (server/src/modules/auth/auth.routes.ts:22) is mounted at
        `/api/v1/auth` (server/src/app.ts:151), so the real path is
        `/auth/me`. `/users/:username` is a different router (the follow
        sub-router) whose username validator requires >= 3 chars
        (server/src/modules/follows/follows.routes.ts:9-15) and would 400 on
        the literal string "me" — confirmed by swil.sh's own comment at its
        `contacts` case ("Self-lookup is /auth/me, NOT /users/me").

        `auth.controller.ts`'s `me` handler returns
        `ok(res, { user: toUserDTO(req.user, { self: true }) })`
        (server/src/modules/auth/auth.controller.ts:47-50), so the response
        is `{"data": {"user": {...}}}`. Returns the unwrapped user object.
        """
        payload = self._client.get("/auth/me")
        data = payload.get("data")
        user = data.get("user") if isinstance(data, dict) else None
        if not isinstance(user, dict):
            raise RuntimeError(f"/auth/me returned no user object; response={payload}")
        return user

    def get_boards(self) -> dict[str, str]:
        """GET /boards -> {"data": {"items": [{"id", "slug", ...}, ...]}}.

        Verified against boards.routes.ts:13-19
        (`ok(res, { items: items.map(toBoardDTO) })`) and `toBoardDTO`
        (server/src/lib/dto.ts:285-294), which emits `id` and `slug` as
        plain strings. Matches the brief's assumed shape exactly.
        """
        payload = self._client.get("/boards")
        data = payload.get("data")
        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return {}
        mapping: dict[str, str] = {}
        for item in items:
            if isinstance(item, dict):
                slug = item.get("slug")
                board_id = item.get("id")
                if isinstance(slug, str) and isinstance(board_id, str):
                    mapping[slug] = board_id
        return mapping

    def feed_global(self, limit: int = 40, sort: str = "recommended") -> list[dict[str, Any]]:
        """GET /feed/global?limit=&sort= — breadth/depth feed passes.

        Contract `01` §2g/§2h: `auto-run.sh` calls this shape twice, once
        with `limit=40&sort=recommended` (breadth pass, first 25 of the 40
        used) and once with `limit=18&sort=latest` (depth pass). Both calls
        share this one method; the defaults here match the breadth pass.
        """
        payload = self._client.get("/feed/global", params={"limit": limit, "sort": sort})
        return _items(payload)

    def feed_board(self, slug: str, limit: int = 12, sort: str = "latest") -> list[dict[str, Any]]:
        """GET /feed/board/{slug}?limit=&sort= — board-scoped feed.

        Contract `01` §2b: read during login for an account with a
        `- **Board:**` bullet in its persona.
        """
        payload = self._client.get(f"/feed/board/{slug}", params={"limit": limit, "sort": sort})
        return _items(payload)

    def search_posts(self, q: str, limit: int = 12) -> list[dict[str, Any]]:
        """GET /posts/search?q=&limit= — topic-keyed search, contract `01` §2b.

        `q` is passed through httpx's own query-param encoder; callers do
        not need to URL-encode it themselves.
        """
        payload = self._client.get("/posts/search", params={"q": q, "limit": limit})
        return _items(payload)

    def get_post(self, post_id: str) -> dict[str, Any]:
        """GET /posts/{id} — single post, used by the thread-context block
        (contract `01` §2i, `swil.sh thread`'s first of two calls).
        """
        payload = self._client.get(f"/posts/{post_id}")
        post = payload.get("data")
        return post if isinstance(post, dict) else {}

    def get_comments(self, post_id: str, limit: int = 6) -> list[dict[str, Any]]:
        """GET /posts/{id}/comments?limit= — the second of `swil.sh thread`'s
        two calls (contract `01` §2i).
        """
        payload = self._client.get(f"/posts/{post_id}/comments", params={"limit": limit})
        return _items(payload)

    def notifications(self, limit: int = 8, unread_only: bool = True) -> list[dict[str, Any]]:
        """GET /notifications?limit=&unreadOnly= — contract `01` §2j.

        `unreadOnly` is only sent (as the literal string `"true"`, matching
        `swil.sh`'s query string) when `unread_only` is true; the parameter
        is omitted entirely rather than sent as `"false"` when it is not,
        since there is no observed caller that ever passes false.
        """
        params: dict[str, Any] = {"limit": limit}
        if unread_only:
            params["unreadOnly"] = "true"
        return _items(self._client.get("/notifications", params=params))

    def conversations(self, limit: int = 6) -> list[dict[str, Any]]:
        """GET /conversations?limit= — contract `01` §2k (`swil.sh dms`)."""
        return _items(self._client.get("/conversations", params={"limit": limit}))

    def user_posts(self, username: str, limit: int = 12) -> list[dict[str, Any]]:
        """GET /users/{username}/posts?limit=."""
        return _items(self._client.get(f"/users/{username}/posts", params={"limit": limit}))

    def update_profile(self, patch: dict[str, Any]) -> None:
        """PATCH /users/me with `patch` as the body — used for the
        `agentBackend` profile sync (contract `01` §2, auto-run.sh:473-494).
        """
        self._client.patch("/users/me", json=patch)

    def contacts(self) -> list[str]:
        """DM-eligible usernames: the union of following, followers, and
        conversation participants, minus self — contract `01` §2k
        (`swil.sh contacts`).

        Self resolves via `me()` (`/auth/me`), **not** `/users/me` — the
        follows sub-router rejects `"me"` as too short a username. Returns
        `[]` (rather than raising) if `me()`'s user object carries no usable
        `username`, matching this method's status as prompt-context input:
        a bad self-lookup degrades the DM list, not the round. `me()`
        itself still raises on a missing user object entirely — this only
        guards the narrower "object present, field absent" shape.
        """
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

    def create_post(
        self,
        text: str,
        board_id: str | None = None,
        image: tuple[str, bytes] | None = None,
    ) -> str:
        """POST /posts -> {"data": {"post": {"id": ...}}}, status 201.

        Verified against posts.controller.ts:9-21
        (`ok(res, { post: toPostDTO(post, ctx) }, 201)`) — matches the
        brief. The multipart field name did NOT match the brief, though:
        multer is configured with
        `upload.fields([{ name: 'images', maxCount: 4 }, ...])`
        (posts.routes.ts:47-50) and the controller reads
        `fields['images']` (posts.controller.ts:12) — plural "images", not
        "image". swil.sh's own image-post path confirms this
        (`-F "images=@${IMGFILE}..."`, agent/scripts/swil.sh line ~441-444).
        A caller sending the brief's singular "image" field would 201 with
        a text-only post and no error — a second silent-failure shape this
        task exists to close off.
        """
        body: dict[str, str] = {"text": text}
        if board_id:
            body["boardId"] = board_id
        if image is None:
            payload = self._client.post("/posts", json=body)
        else:
            filename, blob = image
            payload = self._client.post_multipart(
                "/posts", files={"images": (filename, blob)}, data=body
            )
        post_id = _nested_id(payload, "data", "post", "id")
        if post_id is None:
            raise WriteNotVerifiedError(f"post created no id; response={payload}")
        return post_id

    def create_comment(self, post_id: str, text: str, parent_id: str | None = None) -> str:
        """POST /posts/{id}/comments -> {"data": {"comment": {"id": ...}}}.

        Id path already verified against swil.sh (agent/scripts/swil.sh
        line 494: `.data.comment.id`) prior to this task; unchanged here.
        """
        body: dict[str, str] = {"text": text}
        if parent_id:
            body["parentId"] = parent_id
        payload = self._client.post(f"/posts/{post_id}/comments", json=body)
        comment_id = _nested_id(payload, "data", "comment", "id")
        if comment_id is None:
            raise WriteNotVerifiedError(f"comment created no id; response={payload}")
        return comment_id

    def like_post(self, post_id: str) -> None:
        """POST /posts/{id}/like — there is no created id, but there IS a
        state field to verify against, contrary to the brief's assumption
        that only "2xx and a parseable envelope" was available.

        `likes.service.ts`'s `like()` is idempotent (a fresh like and a
        repeat like both hit this path) and always returns
        `{ likeCount, liked: true }` on success
        (server/src/modules/likes/likes.service.ts:70-126, return statements
        at lines 87 and 125 both set `liked: true`); `likes.controller.ts`
        wraps that as `ok(res, out)`
        (server/src/modules/likes/likes.controller.ts:7-13), so the body is
        `{"data": {"likeCount": N, "liked": true}}`. There is no error path
        that returns `liked: false` from THIS endpoint (`false` only comes
        back from `unlike`), so asserting `data.liked is True` is a real
        verification of the state, not a formality — a response that
        parses as JSON but omits or falsifies `liked` (e.g. a
        proxy/middleware swallowing the write) is exactly the silent
        failure this task exists to catch, and now raises instead of
        passing.
        """
        payload = self._client.post(f"/posts/{post_id}/like")
        data = payload.get("data")
        liked = data.get("liked") if isinstance(data, dict) else None
        if liked is not True:
            raise WriteNotVerifiedError(f"like did not confirm liked=true; response={payload}")

    def follow(self, username: str) -> None:
        """POST /users/{username}/follow — no JSON body at all on success.

        `follows.controller.ts`'s `follow` handler calls
        `return noContent(res)` (server/src/modules/follows/
        follows.controller.ts:7-11), and `noContent` is
        `res.status(204).end()` (server/src/lib/respond.ts:10-12) — a bare
        204 with an empty body. `ApiClient.post()` would raise `ApiError`
        trying to `.json()`-parse that empty body (see
        `ApiClient._payload`), so this uses `raw_post` and verifies the
        status code directly instead.

        "Already following" is a real, distinct server response, not an
        artifact of the brief's guess: `follows.service.ts`'s `follow()`
        does `if (!edge) throw AppError.conflict('Already following this
        user')` on the no-op insert
        (server/src/modules/follows/follows.service.ts:28-34), which is a
        409 with body `{"error": {"code": "CONFLICT", ...}}`
        (`AppError.conflict` -> status 409 code 'CONFLICT',
        server/src/lib/errors.ts:32-34; serialized by
        server/src/middlewares/errorHandler.ts:21-28). swil.sh's
        `_curl -X POST ... | jq .` pipeline (agent/scripts/swil.sh:681)
        never inspected `_curl`'s exit status either (same bug class as
        `like`), so in practice a 409 there was already swallowed as
        "success" by accident. Here it is swallowed on purpose: the end
        state (the follow edge exists) is identical whether this call or an
        earlier one created it, so treating CONFLICT as success matches the
        Bash contract deliberately rather than by masked exit code.
        """
        try:
            response = self._client.raw_post(f"/users/{username}/follow")
        except ApiError as exc:
            if exc.code == "CONFLICT":
                return
            raise
        if response.status_code != 204:
            raise WriteNotVerifiedError(
                f"follow returned unexpected status {response.status_code} "
                "(expected 204 No Content per follows.controller.ts)"
            )

    def send_dm(self, username: str, text: str) -> str:
        """Two calls, NOT `POST /messages` as the brief guessed.

        There is no `/messages` route at all. Direct messages go through a
        conversations resource (server/src/modules/messages/
        messages.routes.ts, mounted at `/api/v1/conversations` in
        server/src/app.ts:164). The two-call shape below is derived from
        that server source, which is what this checkout actually contains
        and what a reader here can verify. It is additionally corroborated
        by a `dm` case in `swil.sh` doing the same find-or-create-then-send
        two calls — but that case is UNCOMMITTED at the time of writing and
        therefore absent from this repository's checked-out `swil.sh`; it
        exists only in one working tree elsewhere, so no line numbers are
        cited for it here.

          1. `POST /conversations` with `{"recipientUsername": username}`
             -> `{"data": {"conversation": {"id": ...}}}`, 201 if a new
             conversation was created, 200 if one already existed
             (messages.routes.ts:37-54,
             `return ok(res, { conversation: dto }, created ? 201 : 200)`).
          2. `POST /conversations/{conversationId}/messages` with
             `{"text": text}` -> `{"data": {"message": {"id": ...}}}`,
             status 201 (messages.routes.ts:91-102,
             `return ok(res, { message: dto }, 201)`).

        Both steps are independently id-verified; a conversation created
        with no id is just as much a silent-failure shape as a message sent
        with no id, so both raise `WriteNotVerifiedError` rather than only
        checking the final step.
        """
        conv_payload = self._client.post("/conversations", json={"recipientUsername": username})
        conversation_id = _nested_id(conv_payload, "data", "conversation", "id")
        if conversation_id is None:
            raise WriteNotVerifiedError(f"conversation created no id; response={conv_payload}")
        msg_payload = self._client.post(
            f"/conversations/{conversation_id}/messages", json={"text": text}
        )
        message_id = _nested_id(msg_payload, "data", "message", "id")
        if message_id is None:
            raise WriteNotVerifiedError(f"dm created no id; response={msg_payload}")
        return message_id

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
