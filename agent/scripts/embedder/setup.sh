#!/usr/bin/env bash
# setup.sh — one-time installer for the local embedder daemon.
#
# Creates a Python venv under agent/scripts/embedder/.venv, installs deps,
# and pre-downloads the bge-m3 weights (~2.3GB) so the first start.sh boot
# doesn't time-out launchd's keep-alive.
#
# Idempotent: re-runs are safe and skip already-installed pieces.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"

if [[ ! -d "$VENV" ]]; then
  echo "[setup] creating venv at $VENV"
  python3 -m venv "$VENV"
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"

echo "[setup] upgrading pip"
pip install --upgrade --quiet pip

echo "[setup] installing requirements"
pip install --quiet -r "$HERE/requirements.txt"

# Pre-download bge-m3 so launchd's first start is fast.
MODEL="${EMBEDDER_MODEL:-BAAI/bge-m3}"
echo "[setup] warming model cache for $MODEL (this downloads ~2.3GB first run)"
python - <<PY
from sentence_transformers import SentenceTransformer
m = SentenceTransformer("$MODEL")
print("[setup] model loaded, dim =", m.get_sentence_embedding_dimension())
PY

echo "[setup] done"
