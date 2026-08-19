#!/usr/bin/env bash
# POSIX counterpart of start.ps1. Starts Luma for real use: server in the
# background, Cloudflare tunnel in front of it, logs and pids under run/. Safe to
# run when it is already up — it stops the previous instance first.
#
#   --local     skip the tunnel, listen on 127.0.0.1 only
#   --port N    override the listening port (the tunnel expects the default)
#   --no-comfy  accepted for parity with start.ps1; see the note below
set -uo pipefail

# shellcheck source=scripts/common.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

PORT=8090
LOCAL=0
while [ "$#" -gt 0 ]; do
  case "$1" in
  --port)
    PORT="$2"
    shift 2
    ;;
  --local)
    LOCAL=1
    shift
    ;;
  --no-comfy)
    shift
    ;;
  *)
    echo "unknown argument: $1" >&2
    exit 2
    ;;
  esac
done

NODE="$(luma_node)" || exit 1
luma_use_node "$NODE"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not on PATH; it builds the web bundle the server hands out." >&2
  exit 1
fi

RUN_DIR="$PROJECT_DIR/run"
TUNNEL_DIR="$PROJECT_DIR/runtime/cloudflared"

export LUMA_PORT="$PORT"
# Behind the tunnel every request arrives from 127.0.0.1, so without this the
# per-client lockout has a single bucket the whole internet shares — and the
# security screen cannot tell an HTTPS connection from a plaintext one. Declared
# only when something really is in front: read unconditionally, a forwarded
# address is a fresh rate-limit budget per request and a forwarded protocol is
# whatever the caller says it is.
if [ "$LOCAL" = 1 ]; then
  unset LUMA_TRUST_PROXY
else
  export LUMA_TRUST_PROXY=1
fi
# restart.sh sets a throwaway code for development; it must never seed a real run.
unset LUMA_ACCESS_CODE
mkdir -p "$RUN_DIR"

bash "$SCRIPTS_DIR/stop.sh" --port "$PORT" >/dev/null

cd "$PROJECT_DIR" || exit 1

# ComfyUI has no POSIX launcher: comfy.ps1 drives the Windows Desktop install
# under %LOCALAPPDATA%, which is not a path that exists here. Luma is fully usable
# without it, minus the local image tools — start ComfyUI however that
# installation wants and Luma will find it on 127.0.0.1:8188.

if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "installing dependencies..."
  npm install --silent
fi

# The server hands out a static bundle, so a stale dist would silently serve
# yesterday's UI. Rebuilding takes under a second.
echo "building web bundle..."
npm run build --silent >/dev/null

LOG="$RUN_DIR/luma.log"
ERR_LOG="$RUN_DIR/luma.err.log"
nohup "$NODE" --import tsx src/server/main.ts >"$LOG" 2>"$ERR_LOG" </dev/null &
SERVER_PID=$!
echo "$SERVER_PID" >"$RUN_DIR/luma.pid"

healthy() {
  "$NODE" -e "fetch('http://127.0.0.1:$PORT/v1/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" \
    >/dev/null 2>&1
}

ready=0
attempt=0
while [ "$attempt" -lt 40 ]; do
  sleep 0.5
  if healthy; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
done
if [ "$ready" != 1 ]; then
  echo "server did not come up; last output:" >&2
  tail -n 20 "$LOG" "$ERR_LOG" 2>/dev/null
  exit 1
fi
echo "Luma is up on http://127.0.0.1:$PORT (pid $SERVER_PID)"

if [ "$LOCAL" != 1 ]; then
  EXE="$TUNNEL_DIR/cloudflared"
  [ -x "$EXE" ] || EXE="$TUNNEL_DIR/cloudflared.exe"
  CONFIG="$TUNNEL_DIR/config.yml"
  if [ -x "$EXE" ]; then
    nohup "$EXE" --config "$CONFIG" tunnel run \
      >"$RUN_DIR/tunnel.log" 2>"$RUN_DIR/tunnel.err.log" </dev/null &
    TUNNEL_PID=$!
    echo "$TUNNEL_PID" >"$RUN_DIR/tunnel.pid"
    sleep 3
    HOSTNAME_VALUE="$(sed -n 's/^[[:space:]]*hostname:[[:space:]]*\([^[:space:]]*\).*/\1/p' "$CONFIG" | head -n 1)"
    echo "Public address: https://$HOSTNAME_VALUE (pid $TUNNEL_PID)"
  else
    echo "cloudflared not found at $TUNNEL_DIR; running local-only."
  fi
fi

bash "$SCRIPTS_DIR/show-code.sh"
