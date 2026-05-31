#!/usr/bin/env bash
# start.sh — boot the embedder daemon (uvicorn) bound to localhost:7777.
# Intended to be exec'd by launchd. Foreground process, KeepAlive handles restart.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"

if [[ ! -x "$VENV/bin/uvicorn" ]]; then
  echo "[start] venv missing — run $HERE/setup.sh first" >&2
  exit 1
fi

export PYTHONUNBUFFERED=1
cd "$HERE"
exec "$VENV/bin/uvicorn" server:app \
  --host 127.0.0.1 \
  --port "${EMBEDDER_PORT:-7777}" \
  --workers 1
