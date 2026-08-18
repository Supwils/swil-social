"""Image fetch for image posts, ports `_fetch_image` (agent/scripts/swil.sh:141) whole.

Returns bytes in memory rather than a temp file path. `_fetch_image` used to
build its temp path with `mktemp /tmp/swil_img_XXXXXX.jpg` -- a `.jpg` suffix
trailing the `X` run, and `mktemp` only substitutes a *trailing* run of `X`s,
so with a non-`X` suffix appended the whole template resolved to one fixed,
unrandomized path. Two concurrent image posts wrote that same
`/tmp/swil_img_XXXXXX.jpg`; whichever process finished second clobbered the
first process's file, and the loser's post silently degraded to text-only
with nothing in any log. That defect is NOT currently live: commit
`98bf730` already patched it on the Bash side (`tmpbase=$(mktemp
/tmp/swil_img_XXXXXX)` -- no suffix, so the trailing-X run IS substituted --
followed by a rename to append `.jpg`), before this porting task started.
This module's in-memory design still goes a step further than that patch:
it removes the shared temp-file resource altogether rather than randomising
it better, so there is nothing left for two concurrent callers, in any
process, to collide over, and no orphaned temp file to clean up on failure
either.

Endpoint/params/response-shape and the fallback below were read out of
`_fetch_image` itself, not assumed from a spec:

  * Unsplash: `GET https://api.unsplash.com/photos/random` (the RANDOM
    endpoint, NOT `/search/photos`) with `query`, `orientation=landscape`,
    and `content_filter=high`, authenticated via `Authorization: Client-ID
    <key>` (swil.sh:153-161). The response is a *single* JSON object --
    `jq -r '.urls.regular // empty'` reads `.urls.regular` directly off the
    top level, not `.results[0].urls.regular` the way `/search/photos`
    would shape it.

  * Picsum fallback (swil.sh:167-173): fires whenever the Unsplash attempt
    leaves `fetched` at `0`. Reading the bash precisely: `fetched` is set to
    `1` only by the download curl's own `&&`
    (`curl ... -o "$tmpfile" "$image_url" ... && fetched=1`); neither curl
    call's HTTP status is ever inspected (no `-f`/`--fail`), and the search
    call's own exit status is never checked either (`image_url=$(curl ... |
    jq ...)` never tests `$?`). So EVERY Unsplash failure class collapses to
    the same `fetched=0` -> Picsum branch, with no distinction between them:
    missing `UNSPLASH_ACCESS_KEY`, a non-2xx search response, a malformed or
    keyless JSON body, curl/network failure on either request, or an empty
    download. This module reproduces that uniformly: `fetch_unsplash_image`
    falls back to Picsum on ANY failure out of the Unsplash attempt, full
    stop -- there is no failure class Bash treats differently, so there is
    none to special-case here either. Bash's FINAL gate for the whole
    function is only `[[ "$fetched" -eq 1 && -s "$tmpfile" ]]` -- non-empty
    output, with NO status-code check anywhere, on EITHER curl download (the
    Unsplash image or the Picsum fallback alike).

    `_fetch_picsum` below matches that leniency exactly: a non-empty body is
    success regardless of status code, same as Bash.

    `_fetch_unsplash`'s download leg (the second `client.get`, fetching the
    URL Unsplash's search returned) does NOT match it, and this is a
    DELIBERATE divergence from Bash, not an oversight: it additionally
    rejects a non-2xx response even when the body is non-empty, where Bash
    would silently accept it. Demonstrated live: point that URL at a host
    that returns 403 with a non-empty body, and Bash's `-s "$tmpfile"` check
    still passes -- it uploads the error page's bytes as if they were the
    photo. That is a latent defect in Bash, not a behaviour worth
    reproducing, so this port does not reproduce it. The divergence is
    low-risk specifically because the Picsum fallback still runs first and
    is just as lenient as Bash, so it usually succeeds; a caller only ever
    sees `ImageFetchError` (and therefore a text-only post) instead of
    Bash's error-page-as-photo when the Unsplash download returns a non-2xx
    status AND Picsum ALSO fails. See
    `test_unsplash_download_non_2xx_with_body_falls_back_to_picsum` and
    `test_picsum_http_error_with_non_empty_body_is_not_a_failure` for the
    two sides of this asymmetry pinned down as tests -- one accepts a
    non-2xx body, the other does not, on purpose.

Fail-soft: `fetch_unsplash_image` raises `ImageFetchError` only once BOTH
Unsplash and the Picsum fallback have failed, matching Bash's empty-
`IMGFILE` fallthrough to a text-only post. A raw httpx exception is never
allowed to escape this module -- both attempts are made inside the same
`with httpx.Client(...)` block and any `httpx.HTTPError` from either one is
caught alongside `ImageFetchError`, so `ImageFetchError` is the one type a
caller ever needs to catch.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

import httpx

_UNSPLASH_RANDOM_URL = "https://api.unsplash.com/photos/random"
_PICSUM_URL_TEMPLATE = "https://picsum.photos/seed/{seed}/900/600"
DEFAULT_TIMEOUT = 20.0
_UNSAFE = re.compile(r"[^A-Za-z0-9_-]+")


class ImageFetchError(RuntimeError):
    """Any failure to obtain an image (Unsplash AND its Picsum fallback both
    failed). Never fatal to the post."""


def safe_temp_name(topic: str) -> str:
    """A multipart-safe filename, unique per call.

    No shared state backs this -- no file, no counter, no pid/time seed --
    so uniqueness comes entirely from `uuid.uuid4()`'s OS-CSPRNG randomness.
    That is the structural fix for the Bash defect: it is not that the Bash
    *code* forgot to guard a shared path, it is that this design has no
    shared path for two concurrent callers (same process or, as in the
    original bug, two separate OS processes) to race over.

    `topic` is sanitised down to `[A-Za-z0-9_-]`, so it can never introduce a
    path separator, a colon, or a newline into the resulting name.
    """
    slug = _UNSAFE.sub("_", topic).strip("_")[:40] or "image"
    return f"swil_img_{slug}_{uuid.uuid4().hex}.jpg"


def fetch_unsplash_image(
    topic: str,
    access_key: str,
    transport: httpx.BaseTransport | None = None,
) -> tuple[str, bytes]:
    """Fetch one image for `topic`: try Unsplash, fall back to Picsum on ANY
    failure, and raise `ImageFetchError` only once both have failed. Never
    returns a half-built result and never lets a raw httpx exception escape
    -- see the module docstring for exactly which Bash branch each half
    ports.
    """
    with httpx.Client(
        transport=transport, timeout=DEFAULT_TIMEOUT, follow_redirects=True
    ) as client:
        # `except ... as exc` unbinds `exc` at the end of its own except
        # block (Python 3 scoping), so the first failure is copied into this
        # plain variable rather than referenced by the except-clause name
        # once we're past it -- referencing the except-clause name itself
        # from the second except block below raises UnboundLocalError.
        unsplash_error: BaseException | None = None
        try:
            return _fetch_unsplash(client, topic, access_key)
        except (ImageFetchError, httpx.HTTPError) as exc:
            unsplash_error = exc

        try:
            return _fetch_picsum(client, topic)
        except (ImageFetchError, httpx.HTTPError) as exc:
            raise ImageFetchError(
                f"unsplash failed ({unsplash_error}); picsum fallback also failed ({exc})"
            ) from exc


def _fetch_unsplash(client: httpx.Client, topic: str, access_key: str) -> tuple[str, bytes]:
    """The Unsplash attempt. Bash skips this branch entirely when
    `UNSPLASH_ACCESS_KEY` is unset (`if [[ -n "${UNSPLASH_ACCESS_KEY:-}" ]]`,
    swil.sh:153); an empty `access_key` here does the same, going straight
    to the caller's Picsum fallback rather than sending an unauthenticated
    request.

    The download leg below rejects a non-2xx response even with a non-empty
    body -- a deliberate divergence from Bash, which doesn't check status at
    all there. See the module docstring for why.
    """
    if not access_key:
        raise ImageFetchError("no unsplash access key configured")

    response = client.get(
        _UNSPLASH_RANDOM_URL,
        params={"query": topic, "orientation": "landscape", "content_filter": "high"},
        headers={"Authorization": f"Client-ID {access_key}"},
    )
    if response.status_code >= 400:
        raise ImageFetchError(f"unsplash search HTTP {response.status_code}: {response.text[:200]}")

    try:
        payload: Any = response.json()
    except ValueError as exc:
        raise ImageFetchError("unsplash search returned non-JSON") from exc

    url = _regular_url(payload)
    if url is None:
        raise ImageFetchError(f"no unsplash result for topic {topic!r}")

    download = client.get(url)
    if download.status_code >= 400:
        raise ImageFetchError(
            f"image download HTTP {download.status_code} "
            "(non-2xx; rejected even with a body -- unlike bash, see module docstring)"
        )
    if not download.content:
        raise ImageFetchError("image download returned an empty body")

    return safe_temp_name(topic), download.content


def _fetch_picsum(client: httpx.Client, topic: str) -> tuple[str, bytes]:
    """The Picsum fallback (swil.sh:167-173). Deliberately does NOT check
    the response status code -- Bash's own picsum curl call has no `-f`, so
    an HTTP error there is invisible to it too; the only gate Bash applies
    is "did any bytes land in the file" (`-s "$tmpfile"`), which this
    mirrors as "is the body non-empty".
    """
    url = _PICSUM_URL_TEMPLATE.format(seed=_picsum_seed(topic))
    download = client.get(url)
    if not download.content:
        raise ImageFetchError("picsum download returned an empty body")
    return safe_temp_name(topic), download.content


def _picsum_seed(topic: str) -> str:
    """`echo "$topic" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | cut -c1-24`
    (swil.sh:170), translated: lowercase, literal spaces (only) become
    hyphens, then the first 24 characters. Python string slicing is
    code-point based, matching `cut -c` under a UTF-8 locale -- but `cut -c`
    is BYTE-oriented instead under a C/POSIX locale, and nobody has verified
    which locale `_fetch_image` actually runs under in production. For a
    CJK topic (personas do post in Chinese) a C-locale `cut -c1-24` would
    truncate mid-multibyte-character and land on a different seed than this
    codepoint-based slice. Noted, not chased further -- low-stakes (picsum
    still returns *an* image either way, just seeded differently).
    """
    return topic.lower().replace(" ", "-")[:24]


def _regular_url(payload: Any) -> str | None:
    """Extract `.urls.regular` from a `/photos/random` response object.

    `/photos/random` returns a single JSON object when no `count` param is
    given (Bash never passes one) -- not a `{"results": [...]}` list, unlike
    `/search/photos`. A dict without a usable `urls.regular` string (missing
    keys, wrong types, or an empty string) yields `None` rather than
    raising, matching Bash's `jq -r '.urls.regular // empty'` fallback.
    """
    if not isinstance(payload, dict):
        return None
    urls = payload.get("urls")
    if not isinstance(urls, dict):
        return None
    url = urls.get("regular")
    return url if isinstance(url, str) and url else None
