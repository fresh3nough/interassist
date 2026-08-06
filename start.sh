#!/usr/bin/env bash
# InterAssist local launcher — install deps and start back + front

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACK="$ROOT/back"
FRONT="$ROOT/front"
BACK_PORT="${BACK_PORT:-8000}"
FRONT_PORT="${FRONT_PORT:-5173}"
LOG_DIR="$ROOT/.run"
mkdir -p "$LOG_DIR"

# Prefer Homebrew Python 3.12 (system 3.14 breaks pydantic pins)
if [[ -x /opt/homebrew/bin/python3.12 ]]; then
  PYTHON=/opt/homebrew/bin/python3.12
elif command -v python3.12 >/dev/null 2>&1; then
  PYTHON="$(command -v python3.12)"
elif command -v python3.11 >/dev/null 2>&1; then
  PYTHON="$(command -v python3.11)"
else
  PYTHON="$(command -v python3)"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm not found — install Node.js first"
  exit 1
fi

echo "==> InterAssist"
echo "    root:   $ROOT"
echo "    python: $PYTHON ($("$PYTHON" --version 2>&1))"
echo "    node:   $(node --version 2>&1)"
echo

# Backend env
if [[ ! -f "$BACK/.env" ]]; then
  if [[ -f "$BACK/.env.example" ]]; then
    cp "$BACK/.env.example" "$BACK/.env"
    echo "==> created back/.env from .env.example — add your OPENROUTER_API_KEY"
  else
    echo "error: missing back/.env and back/.env.example"
    exit 1
  fi
fi

# Backend venv + deps
echo "==> backend deps"
if [[ ! -d "$BACK/.venv" ]]; then
  "$PYTHON" -m venv "$BACK/.venv"
fi
# shellcheck disable=SC1091
source "$BACK/.venv/bin/activate"
python -m pip install -q --upgrade pip
pip install -q -r "$BACK/requirements.txt"
deactivate

# Frontend deps
echo "==> frontend deps"
(
  cd "$FRONT"
  if [[ ! -d node_modules ]]; then
    npm install
  else
    npm install --no-fund --no-audit
  fi
)

cleanup() {
  echo
  echo "==> stopping…"
  if [[ -n "${BACK_PID:-}" ]] && kill -0 "$BACK_PID" 2>/dev/null; then
    kill "$BACK_PID" 2>/dev/null || true
  fi
  if [[ -n "${FRONT_PID:-}" ]] && kill -0 "$FRONT_PID" 2>/dev/null; then
    kill "$FRONT_PID" 2>/dev/null || true
  fi
  # child process groups if any linger
  wait 2>/dev/null || true
  echo "==> stopped"
}
trap cleanup INT TERM EXIT

# Free ports if stale processes hold them (best-effort)
for port in "$BACK_PORT" "$FRONT_PORT"; do
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      echo "==> freeing port $port (pids: $pids)"
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
      sleep 0.5
    fi
  fi
done

echo "==> starting backend  http://127.0.0.1:$BACK_PORT"
(
  cd "$BACK"
  # shellcheck disable=SC1091
  source .venv/bin/activate
  exec uvicorn main:app --host 127.0.0.1 --port "$BACK_PORT" --reload
) >"$LOG_DIR/back.log" 2>&1 &
BACK_PID=$!

echo "==> starting frontend http://127.0.0.1:$FRONT_PORT"
(
  cd "$FRONT"
  exec npm run dev -- --host 127.0.0.1 --port "$FRONT_PORT"
) >"$LOG_DIR/front.log" 2>&1 &
FRONT_PID=$!

# Wait for health
echo -n "==> waiting for backend"
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$BACK_PORT/api/health" >/dev/null 2>&1; then
    echo " ready"
    break
  fi
  if ! kill -0 "$BACK_PID" 2>/dev/null; then
    echo
    echo "error: backend exited — see $LOG_DIR/back.log"
    tail -n 40 "$LOG_DIR/back.log" || true
    exit 1
  fi
  echo -n "."
  sleep 0.25
done

if ! curl -sf "http://127.0.0.1:$BACK_PORT/api/health" >/dev/null 2>&1; then
  echo
  echo "error: backend did not become healthy — see $LOG_DIR/back.log"
  tail -n 40 "$LOG_DIR/back.log" || true
  exit 1
fi

echo
echo "InterAssist is running"
echo "  UI:      http://127.0.0.1:$FRONT_PORT"
echo "  API:     http://127.0.0.1:$BACK_PORT"
echo "  health:  http://127.0.0.1:$BACK_PORT/api/health"
echo "  logs:    $LOG_DIR/back.log  $LOG_DIR/front.log"
echo
echo "Press Ctrl+C to stop."
echo

# Stream logs while both stay up
tail -n 0 -F "$LOG_DIR/back.log" "$LOG_DIR/front.log" &
TAIL_PID=$!

while kill -0 "$BACK_PID" 2>/dev/null && kill -0 "$FRONT_PID" 2>/dev/null; do
  sleep 1
done

kill "$TAIL_PID" 2>/dev/null || true

if ! kill -0 "$BACK_PID" 2>/dev/null; then
  echo "error: backend stopped — see $LOG_DIR/back.log"
  tail -n 40 "$LOG_DIR/back.log" || true
  exit 1
fi
if ! kill -0 "$FRONT_PID" 2>/dev/null; then
  echo "error: frontend stopped — see $LOG_DIR/front.log"
  tail -n 40 "$LOG_DIR/front.log" || true
  exit 1
fi
