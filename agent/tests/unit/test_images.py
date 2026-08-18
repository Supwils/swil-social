"""Tests for swil_agent.api.images.

Response fixtures use the real `/photos/random` single-object shape
(`{"urls": {"regular": ...}}`), not the `/search/photos` list shape
(`{"results": [...]}`) -- that is the actual request/response shape
`_fetch_image` uses in `agent/scripts/swil.sh`, verified against the Bash
source (see images.py's module docstring), and this test suite is what
would have caught building against the wrong endpoint.

Bash's `_fetch_image` falls back to Picsum whenever the Unsplash attempt
leaves `fetched` at 0 -- which, on inspection, is EVERY Unsplash failure
class uniformly (missing key, non-2xx, malformed/keyless JSON, curl/network
failure, or an empty download; see images.py's module docstring for the
line-by-line reading). There is no failure class Bash treats differently,
so there is no "does NOT fall back" case to test -- the acceptance criteria
for this behaviour asked to skip that case explicitly if Bash falls back on
everything, and this file does.
"""

from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor

import httpx
import pytest

from swil_agent.api.images import ImageFetchError, fetch_unsplash_image, safe_temp_name

# ── safe_temp_name ───────────────────────────────────────────────────────


def test_safe_temp_name_is_unique_across_calls() -> None:
    names = {safe_temp_name("old mailboxes") for _ in range(50)}
    assert len(names) == 50, "concurrent image posts must not share a filename"


def test_safe_temp_name_is_unique_across_processes() -> None:
    """The Bash defect this module's design fixes was two SEPARATE OS
    PROCESSES computing the same fixed `mktemp` path and one clobbering the
    other's file. A same-process loop (above) only proves the generator
    isn't trivially deterministic within one interpreter -- it cannot by
    itself rule out a scheme that happens to collide across a real process
    boundary (a pid- or wall-clock-seeded name, for instance, where a fast
    process-pool spawn could land two workers on the same tick). Driving
    `safe_temp_name` from genuinely separate worker processes reproduces the
    actual shape of the original failure and is the test that would catch a
    regression a pure-loop test would miss.
    """
    with ProcessPoolExecutor(max_workers=4) as pool:
        names = list(pool.map(safe_temp_name, ["shared topic"] * 20))
    assert len(set(names)) == len(names)


def test_safe_temp_name_sanitises_the_topic() -> None:
    name = safe_temp_name("a/b c:d")
    assert "/" not in name
    assert ":" not in name
    assert name.endswith(".jpg")


def test_safe_temp_name_strips_newlines() -> None:
    """The filename is placed straight into a multipart header
    (`files={"images": (filename, blob)}` in resources.py); a newline in it
    would let a malicious or malformed topic inject an extra header line."""
    name = safe_temp_name("line one\nline two\rline three")
    assert "\n" not in name
    assert "\r" not in name


# ── Unsplash request shape ───────────────────────────────────────────────


def test_fetch_calls_the_random_photo_endpoint_with_expected_params_and_auth() -> None:
    """Locks in the exact request shape `_fetch_image` uses
    (agent/scripts/swil.sh:141): `GET https://api.unsplash.com/photos/random`
    with `query` / `orientation=landscape` / `content_filter=high` query
    params and a `Client-ID` auth header -- NOT `/search/photos` with
    `per_page`, which "search" in the task's own name could easily suggest
    instead."""
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.unsplash.com":
            seen["path"] = request.url.path
            seen["query"] = request.url.params.get("query", "")
            seen["orientation"] = request.url.params.get("orientation", "")
            seen["content_filter"] = request.url.params.get("content_filter", "")
            seen["auth"] = request.headers.get("authorization", "")
            return httpx.Response(200, json={"urls": {"regular": "https://images.test/photo.jpg"}})
        return httpx.Response(200, content=b"\xff\xd8\xff\xd9")

    fetch_unsplash_image("old mailboxes", "abc123", transport=httpx.MockTransport(handler))

    assert seen["path"] == "/photos/random"
    assert seen["query"] == "old mailboxes"
    assert seen["orientation"] == "landscape"
    assert seen["content_filter"] == "high"
    assert seen["auth"] == "Client-ID abc123"


def test_fetch_returns_filename_and_bytes() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.unsplash.com":
            return httpx.Response(200, json={"urls": {"regular": "https://images.test/photo.jpg"}})
        return httpx.Response(200, content=b"\xff\xd8\xff\xd9")

    filename, blob = fetch_unsplash_image(
        "old mailboxes", "key", transport=httpx.MockTransport(handler)
    )
    assert filename.endswith(".jpg")
    assert blob == b"\xff\xd8\xff\xd9"


# ── Acceptance 1: Unsplash success never touches Picsum ─────────────────


def test_unsplash_success_returns_unsplash_bytes_and_never_calls_picsum() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host)
        if request.url.host == "api.unsplash.com":
            return httpx.Response(200, json={"urls": {"regular": "https://images.test/photo.jpg"}})
        if request.url.host == "images.test":
            return httpx.Response(200, content=b"UNSPLASH-BYTES")
        raise AssertionError(f"unexpected host called: {request.url.host}")  # picsum.photos

    filename, blob = fetch_unsplash_image(
        "mountains", "key", transport=httpx.MockTransport(handler)
    )
    assert blob == b"UNSPLASH-BYTES"
    assert filename.endswith(".jpg")
    assert "picsum.photos" not in calls
    assert calls == ["api.unsplash.com", "images.test"]


# ── Acceptance 2: every Unsplash failure class falls back to Picsum ─────


@pytest.mark.parametrize(
    "mode",
    [
        "no_usable_regular_url",
        "non_object_payload",
        "search_non_json",
        "search_http_error",
        "search_transport_error",
    ],
)
def test_every_unsplash_search_failure_class_falls_back_to_picsum(mode: str) -> None:
    """Bash's `_fetch_image` never inspects curl's exit status or the search
    response's HTTP status (swil.sh:153-165) -- every way the search leg can
    come up empty collapses onto the same `fetched=0` branch, with no
    distinction between them. Parametrized across that whole set (rather
    than asserted once and assumed to generalise) so a regression in any one
    branch's fallback wiring is caught by name."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.unsplash.com":
            if mode == "no_usable_regular_url":
                return httpx.Response(200, json={"urls": {}})
            if mode == "non_object_payload":
                return httpx.Response(200, json=[])
            if mode == "search_non_json":
                return httpx.Response(200, content=b"not json")
            if mode == "search_http_error":
                return httpx.Response(403, json={"errors": ["Rate Limit Exceeded"]})
            if mode == "search_transport_error":
                raise httpx.ConnectError("connection refused", request=request)
            raise AssertionError(f"unhandled mode {mode!r}")
        if request.url.host == "picsum.photos":
            return httpx.Response(200, content=b"PICSUM-BYTES")
        raise AssertionError(f"unexpected host called: {request.url.host}")

    filename, blob = fetch_unsplash_image(
        "mountains", "key", transport=httpx.MockTransport(handler)
    )
    assert blob == b"PICSUM-BYTES", mode
    assert filename.endswith(".jpg")


@pytest.mark.parametrize(
    "mode",
    [
        # 2xx status but nothing came down -- the empty-body branch, and
        # ONLY that branch (status is a plain success, isolating it from
        # the non-2xx branch below).
        "download_2xx_empty_body",
        # non-2xx status WITH a non-empty body -- the status-check branch,
        # and ONLY that branch (previously this case used
        # Response(404, content=b""), which is non-2xx AND empty at once
        # and so could not tell which of the two `if`s in _fetch_unsplash
        # actually fired; a body that survives here proves it's the status
        # check, not the empty-body check).
        "download_non_2xx_with_body",
        "download_transport_error",
    ],
)
def test_every_unsplash_download_failure_class_falls_back_to_picsum(mode: str) -> None:
    """Same collapse as above, but for the second curl -- downloading the
    URL Unsplash's search returned (swil.sh:162-164)."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.unsplash.com":
            return httpx.Response(200, json={"urls": {"regular": "https://images.test/photo.jpg"}})
        if request.url.host == "images.test":
            if mode == "download_2xx_empty_body":
                return httpx.Response(200, content=b"")
            if mode == "download_non_2xx_with_body":
                return httpx.Response(404, content=b"not found error page")
            if mode == "download_transport_error":
                raise httpx.ReadError("connection reset", request=request)
            raise AssertionError(f"unhandled mode {mode!r}")
        if request.url.host == "picsum.photos":
            return httpx.Response(200, content=b"PICSUM-BYTES")
        raise AssertionError(f"unexpected host called: {request.url.host}")

    filename, blob = fetch_unsplash_image(
        "mountains", "key", transport=httpx.MockTransport(handler)
    )
    assert blob == b"PICSUM-BYTES", mode
    assert filename.endswith(".jpg")


def test_missing_access_key_falls_back_to_picsum_without_calling_unsplash() -> None:
    """Bash skips the whole Unsplash branch when `UNSPLASH_ACCESS_KEY` is
    unset (`if [[ -n "${UNSPLASH_ACCESS_KEY:-}" ]]`, swil.sh:153) rather
    than sending an unauthenticated request; an empty `access_key` here does
    the same."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host)
        if request.url.host == "picsum.photos":
            return httpx.Response(200, content=b"PICSUM-BYTES")
        raise AssertionError(f"unexpected host called: {request.url.host}")

    filename, blob = fetch_unsplash_image("mountains", "", transport=httpx.MockTransport(handler))
    assert blob == b"PICSUM-BYTES"
    assert filename.endswith(".jpg")
    assert calls == ["picsum.photos"]


# ── Picsum request shape: seed derivation and dimensions ────────────────


def test_picsum_seed_derivation_short_topic() -> None:
    """`_fetch_image`'s picsum branch (swil.sh:167-173):
    `seed=$(echo "$topic" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | cut -c1-24)`
    -- lowercase, literal spaces (only) become hyphens. Cross-checked against
    real `tr`/`cut` output for this exact topic, not just re-derived from
    the Python implementation under test."""
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.unsplash.com":
            return httpx.Response(200, json={"urls": {}})
        if request.url.host == "picsum.photos":
            seen["path"] = request.url.path
            return httpx.Response(200, content=b"PICSUM-BYTES")
        raise AssertionError(f"unexpected host called: {request.url.host}")

    fetch_unsplash_image("Old Mailboxes", "key", transport=httpx.MockTransport(handler))

    # bash: echo 'Old Mailboxes' | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | cut -c1-24
    #   -> "old-mailboxes" (13 chars, shorter than the 24-char cap)
    assert seen["path"] == "/seed/old-mailboxes/900/600"


def test_picsum_seed_derivation_truncates_to_24_characters() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.unsplash.com":
            return httpx.Response(200, json={"urls": {}})
        if request.url.host == "picsum.photos":
            seen["path"] = request.url.path
            return httpx.Response(200, content=b"PICSUM-BYTES")
        raise AssertionError(f"unexpected host called: {request.url.host}")

    fetch_unsplash_image(
        "A Very Long Rural Countryside Lane With Many Words",
        "key",
        transport=httpx.MockTransport(handler),
    )

    # bash: echo 'A Very Long Rural Countryside Lane With Many Words' \
    #   | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | cut -c1-24
    #   -> "a-very-long-rural-countr" (exactly 24 chars)
    assert seen["path"] == "/seed/a-very-long-rural-countr/900/600"


# ── Acceptance 3: Unsplash AND Picsum both fail -> ImageFetchError ───────


def test_unsplash_and_picsum_both_failing_raises_image_fetch_error() -> None:
    """Picsum's own failure gate mirrors Bash's final check
    (`[[ "$fetched" -eq 1 && -s "$tmpfile" ]]`, swil.sh:175): an empty body,
    regardless of status code -- picsum's curl has no `-f` either."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.unsplash.com":
            return httpx.Response(200, json={"urls": {}})
        if request.url.host == "picsum.photos":
            return httpx.Response(200, content=b"")
        raise AssertionError(f"unexpected host called: {request.url.host}")

    with pytest.raises(ImageFetchError):
        fetch_unsplash_image("mountains", "key", transport=httpx.MockTransport(handler))


def test_picsum_http_error_with_non_empty_body_is_not_a_failure() -> None:
    """The precise, deliberately lenient flip side of the above: Bash's
    picsum curl has no `-f`, so a non-2xx response with a non-empty body
    (an error page, say) is indistinguishable from success to it -- the
    only thing it checks is "did bytes land in the file". This locks that
    exact leniency in rather than guessing a stricter (wrong) status check."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.unsplash.com":
            return httpx.Response(200, json={"urls": {}})
        if request.url.host == "picsum.photos":
            return httpx.Response(500, content=b"internal error page body")
        raise AssertionError(f"unexpected host called: {request.url.host}")

    filename, blob = fetch_unsplash_image(
        "mountains", "key", transport=httpx.MockTransport(handler)
    )
    assert blob == b"internal error page body"
    assert filename.endswith(".jpg")


def test_unsplash_download_non_2xx_with_body_falls_back_to_picsum() -> None:
    """The mirror of `test_picsum_http_error_with_non_empty_body_is_not_a_
    failure` above, for the leg that behaves OPPOSITELY on purpose: Bash's
    image-download curl is exactly as lenient as its picsum curl (no `-f`,
    only `-s "$tmpfile"` checked at the very end) -- point the download URL
    at a host returning 403 with a non-empty body and real Bash uploads
    that error page's bytes as the "photo". This port's `_fetch_unsplash`
    deliberately does NOT match that leniency: it rejects a non-2xx
    download even with a body, on the reasoning that an HTML/JSON error
    page is not a useful image regardless of what Bash would do with it.
    Because the Picsum fallback still runs first and is just as lenient as
    Bash, the caller here still gets AN image -- Picsum's -- not a
    text-only post; only the SOURCE of the bytes differs from Bash, and
    only in this one corner. See the module docstring's "DELIBERATE
    divergence" paragraph for the full reasoning."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.unsplash.com":
            return httpx.Response(200, json={"urls": {"regular": "https://images.test/photo.jpg"}})
        if request.url.host == "images.test":
            return httpx.Response(403, content=b"<html>forbidden</html>")
        if request.url.host == "picsum.photos":
            return httpx.Response(200, content=b"PICSUM-BYTES")
        raise AssertionError(f"unexpected host called: {request.url.host}")

    filename, blob = fetch_unsplash_image(
        "mountains", "key", transport=httpx.MockTransport(handler)
    )
    assert blob == b"PICSUM-BYTES"
    assert filename.endswith(".jpg")


# ── Fail-soft contract: no raw httpx exception ever escapes ─────────────


def test_both_legs_transport_error_raises_image_fetch_error_not_httpx() -> None:
    """Fail-soft requires the caller to only ever catch ImageFetchError. If a
    raw httpx exception escaped here, the caller (which posts text-only on
    ImageFetchError) would not catch it, and an image fetch failure would
    blow up the whole post instead of degrading gracefully -- exercised here
    through both legs failing at the transport level, the case most likely
    to leak an un-translated exception type."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(ImageFetchError):
        fetch_unsplash_image("x", "key", transport=httpx.MockTransport(handler))
