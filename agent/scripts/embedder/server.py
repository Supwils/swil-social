"""Local sentence-embedding daemon for the swil-social agent runtime.

Loads BAAI/bge-m3 (multilingual, 1024-dim, 8K context) once at startup, exposes
a single /embed endpoint. Caches by sha256(text) in a sibling SQLite file so
re-embedding the same personality.md or post text is free.

Runs on Apple Silicon (M-series) via PyTorch's MPS backend by default; falls
back to CPU on other hardware. The daemon is managed by launchd:
  ~/Library/LaunchAgents/com.swil.embedder.plist
See agent/MAINTENANCE.md for install / pause / restart commands.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import struct
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

MODEL_NAME = os.environ.get("EMBEDDER_MODEL", "BAAI/bge-m3")
DEVICE = os.environ.get("EMBEDDER_DEVICE", "auto")  # auto | mps | cpu | cuda

HERE = Path(__file__).resolve().parent
CACHE_PATH = HERE / "cache.sqlite"

_state: dict[str, object] = {}
_cache_lock = Lock()


def _pick_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def _init_cache() -> sqlite3.Connection:
    conn = sqlite3.connect(CACHE_PATH, check_same_thread=False, isolation_level=None)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS embeddings (
            sha TEXT PRIMARY KEY,
            dim INTEGER NOT NULL,
            vec BLOB NOT NULL
        )"""
    )
    return conn


def _vec_to_blob(vec: np.ndarray) -> bytes:
    # float32 little-endian, length-prefixed by `dim` column
    arr = vec.astype(np.float32, copy=False)
    return arr.tobytes()


def _blob_to_vec(blob: bytes, dim: int) -> list[float]:
    return list(struct.unpack(f"<{dim}f", blob))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Import here so `--help` and import-time tooling don't pull torch.
    from sentence_transformers import SentenceTransformer

    device = _pick_device(DEVICE)
    print(f"[embedder] loading {MODEL_NAME} on device={device}", flush=True)
    model = SentenceTransformer(MODEL_NAME, device=device)
    # Warm the GPU + cache one round-trip
    _ = model.encode(["warmup"], normalize_embeddings=True)
    _state["model"] = model
    _state["device"] = device
    _state["dim"] = int(model.get_sentence_embedding_dimension() or 0)
    _state["cache"] = _init_cache()
    print(f"[embedder] ready · dim={_state['dim']}", flush=True)
    try:
        yield
    finally:
        cache = _state.get("cache")
        if isinstance(cache, sqlite3.Connection):
            cache.close()


app = FastAPI(lifespan=lifespan, title="swil-embedder", version="0.1.0")


class EmbedReq(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=64)
    # If true, returns the same vector twice for an empty string. Most callers
    # should just filter empty strings client-side, but supplying default=False
    # lets us reject ambiguous calls instead of silently caching "".
    allow_empty: bool = False


class EmbedResp(BaseModel):
    model: str
    device: str
    dim: int
    embeddings: list[list[float]]
    cache_hits: int
    cache_misses: int


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "model": MODEL_NAME,
        "device": _state.get("device"),
        "dim": _state.get("dim"),
    }


@app.post("/embed", response_model=EmbedResp)
def embed(req: EmbedReq) -> EmbedResp:
    model = _state.get("model")
    cache = _state.get("cache")
    dim = int(_state.get("dim") or 0)
    if model is None or not isinstance(cache, sqlite3.Connection) or dim == 0:
        raise HTTPException(503, "embedder not initialised")

    if not req.allow_empty and any(not t.strip() for t in req.texts):
        raise HTTPException(422, "blank text in input (set allow_empty=true to override)")

    shas = [hashlib.sha256(t.encode("utf-8")).hexdigest() for t in req.texts]
    placeholders = ",".join(["?"] * len(shas))
    with _cache_lock:
        rows = cache.execute(
            f"SELECT sha, vec FROM embeddings WHERE sha IN ({placeholders})",
            shas,
        ).fetchall()
    found = {sha: blob for sha, blob in rows}

    misses_idx = [i for i, s in enumerate(shas) if s not in found]
    miss_texts = [req.texts[i] for i in misses_idx]

    new_vecs: list[np.ndarray] = []
    if miss_texts:
        new_vecs_raw = model.encode(  # type: ignore[union-attr]
            miss_texts,
            normalize_embeddings=True,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        new_vecs = [np.asarray(v, dtype=np.float32) for v in new_vecs_raw]
        with _cache_lock:
            cache.executemany(
                "INSERT OR REPLACE INTO embeddings(sha, dim, vec) VALUES (?,?,?)",
                [
                    (shas[misses_idx[i]], dim, _vec_to_blob(new_vecs[i]))
                    for i in range(len(misses_idx))
                ],
            )
            # Refresh `found` so the assembly below reads them uniformly.
            for i, vec in zip(misses_idx, new_vecs):
                found[shas[i]] = _vec_to_blob(vec)

    embeddings = [_blob_to_vec(found[sha], dim) for sha in shas]
    return EmbedResp(
        model=MODEL_NAME,
        device=str(_state.get("device")),
        dim=dim,
        embeddings=embeddings,
        cache_hits=len(req.texts) - len(misses_idx),
        cache_misses=len(misses_idx),
    )
