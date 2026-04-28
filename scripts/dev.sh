#!/usr/bin/env bash
# Boot both processes for the voice demo:
#   - Python TTS sidecar (uses official kugelaudio SDK)
#   - Node Express server (watsonx orchestration + UI)
# Sidecar dies with this script; Node runs in foreground so you see logs.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

VENV=.venv-tts
if [ ! -d "$VENV" ]; then
  echo "[dev] creating Python venv $VENV"
  python3.11 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r requirements-tts.txt
fi

export TTS_SIDECAR_PORT="${TTS_SIDECAR_PORT:-3210}"
export TTS_SIDECAR_URL="http://127.0.0.1:${TTS_SIDECAR_PORT}"
export KUGELAUDIO_MODEL_ID="${KUGELAUDIO_MODEL_ID:-kugel-2}"

echo "[dev] starting tts sidecar on :$TTS_SIDECAR_PORT"
"$VENV/bin/python" tts_sidecar.py &
SIDECAR_PID=$!
trap 'kill $SIDECAR_PID 2>/dev/null || true' EXIT INT TERM

# Wait for sidecar /health before launching Node so the first turn hits a
# warm connection. Cap at ~20s.
for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${TTS_SIDECAR_PORT}/health" >/dev/null; then
    echo "[dev] sidecar ready"
    break
  fi
  sleep 0.5
done

echo "[dev] starting node server"
exec node --watch src/server.js
