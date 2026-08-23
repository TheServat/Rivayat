#!/usr/bin/env bash
# Start the local ComfyUI draft lane with the settings benchmarked for a 6 GB Quadro RTX 3000.
#
# Flags are measured, not guessed — see tools/comfy-workflows/README.md for the numbers.
# We deliberately do NOT pass --lowvram or --use-split-cross-attention: on ComfyUI 0.33
# with torch 2.13 both are counterproductive on this card.
#
#   bash tools/scripts/comfy-start.sh              # start detached, wait until healthy
#   bash tools/scripts/comfy-start.sh --foreground # run in this terminal
#   bash tools/scripts/comfy-start.sh --stop
#
# Env overrides: COMFYUI_HOME, COMFY_PORT, COMFY_BIND
set -euo pipefail

# 8188 is unusable on this machine: it sits inside a Windows reserved TCP exclusion range
# (8163-8262, held by WinNAT/Hyper-V). Check with:
#   netsh interface ipv4 show excludedportrange protocol=tcp
PORT="${COMFY_PORT:-8288}"
BIND="${COMFY_BIND:-127.0.0.1}"
COMFY_HOME="${COMFYUI_HOME:-/d/me/tools/ComfyUI}"
TIMEOUT="${COMFY_TIMEOUT:-120}"
FOREGROUND=0
STOP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --foreground) FOREGROUND=1 ;;
    --stop) STOP=1 ;;
    --port) PORT="$2"; shift ;;
    --bind) BIND="$2"; shift ;;
    --home) COMFY_HOME="$2"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

listening_pid() {
  if command -v netstat >/dev/null 2>&1; then
    netstat -ano -p tcp 2>/dev/null | grep ":${PORT} " | grep LISTENING | awk '{print $NF}' | head -1
  else
    lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null | head -1
  fi
}

if [ "$STOP" -eq 1 ]; then
  pid="$(listening_pid || true)"
  if [ -n "${pid:-}" ]; then
    echo "Stopping ComfyUI (pid $pid) on port $PORT"
    if command -v taskkill >/dev/null 2>&1; then taskkill //PID "$pid" //F >/dev/null; else kill -9 "$pid"; fi
  else
    echo "Nothing listening on port $PORT"
  fi
  exit 0
fi

PYTHON="${COMFY_HOME}/.venv/Scripts/python.exe"
[ -x "$PYTHON" ] || PYTHON="${COMFY_HOME}/.venv/bin/python"
[ -x "$PYTHON" ] || { echo "ComfyUI venv python not found under ${COMFY_HOME}/.venv" >&2; exit 1; }
[ -f "${COMFY_HOME}/main.py" ] || { echo "ComfyUI main.py not found under ${COMFY_HOME}" >&2; exit 1; }

pid="$(listening_pid || true)"
if [ -n "${pid:-}" ]; then
  echo "ComfyUI already listening on ${BIND}:${PORT} (pid $pid)"
  exit 0
fi

# Keep every byte ComfyUI writes inside the gitignored workspace.
OUT_DIR="${REPO_ROOT}/workspace/cache/comfy/output"
TMP_DIR="${REPO_ROOT}/workspace/cache/comfy/temp"
IN_DIR="${REPO_ROOT}/workspace/cache/comfy/input"
LOG_DIR="${REPO_ROOT}/workspace/logs"
mkdir -p "$OUT_DIR" "$TMP_DIR" "$IN_DIR" "$LOG_DIR"

# ComfyUI is a Windows binary here, so hand it Windows-style paths when cygpath exists.
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

ARGS=(
  main.py
  --listen "$BIND"
  --port "$PORT"
  --disable-auto-launch          # headless: never pop a browser
  --disable-all-custom-nodes     # reproducible node set; nothing here needs Manager
  --preview-method none          # latent previews cost VRAM we do not have
  --output-directory "$(winpath "$OUT_DIR")"
  --temp-directory  "$(winpath "$TMP_DIR")"
  --input-directory "$(winpath "$IN_DIR")"
)

cd "$COMFY_HOME"

if [ "$FOREGROUND" -eq 1 ]; then
  echo "Starting ComfyUI in the foreground on ${BIND}:${PORT} (Ctrl-C to stop)"
  exec "$PYTHON" "${ARGS[@]}"
fi

LOG_FILE="${LOG_DIR}/comfyui.log"
echo "Starting ComfyUI on ${BIND}:${PORT}"
echo "  python : $PYTHON"
echo "  log    : $LOG_FILE"
nohup "$PYTHON" "${ARGS[@]}" > "$LOG_FILE" 2>&1 &
child=$!

for _ in $(seq 1 $((TIMEOUT * 2))); do
  if ! kill -0 "$child" 2>/dev/null; then
    echo "ComfyUI exited during startup. Tail of $LOG_FILE:" >&2
    tail -25 "$LOG_FILE" >&2
    exit 1
  fi
  if curl -fsS -m 3 "http://${BIND}:${PORT}/system_stats" >/dev/null 2>&1; then
    echo "ComfyUI ready at http://${BIND}:${PORT} (pid $child)"
    echo "  smoke : node tools/scripts/comfy-smoke.mjs --host http://${BIND}:${PORT}"
    echo "  stop  : bash tools/scripts/comfy-start.sh --stop --port ${PORT}"
    exit 0
  fi
  sleep 0.5
done

echo "ComfyUI did not answer /system_stats within ${TIMEOUT}s. See $LOG_FILE" >&2
exit 1
