#!/usr/bin/env bash
# POSIX counterpart of stop.ps1. Stops the server and the tunnel started by
# start.sh, falling back to whoever holds the port so a run started by hand is
# still cleaned up.
#
#   --port N         the port to reclaim (default 8090)
#   --include-comfy  also stop the image backend, which start.sh deliberately
#                    does not do: it calls this before every launch and ComfyUI
#                    costs a minute to load its models again.
set -uo pipefail

# shellcheck source=scripts/common.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

PORT=8090
INCLUDE_COMFY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
  --port)
    PORT="$2"
    shift 2
    ;;
  --include-comfy)
    INCLUDE_COMFY=1
    shift
    ;;
  *)
    echo "unknown argument: $1" >&2
    exit 2
    ;;
  esac
done

RUN_DIR="$PROJECT_DIR/run"

for name in luma tunnel; do
  pid_file="$RUN_DIR/$name.pid"
  [ -f "$pid_file" ] || continue
  recorded="$(head -n 1 "$pid_file" 2>/dev/null | tr -dc '0-9')"
  [ -n "$recorded" ] && luma_stop_pid "$recorded" "$name"
  rm -f "$pid_file"
done

for owner in $(luma_port_pids "$PORT"); do
  luma_stop_pid "$owner" "listener on $PORT"
done

# MCP servers are stdio children of the server process, and a graceful stop closes
# them with it. So anything left here was orphaned by a kill or a crash, and with
# the server already gone nothing running out of this directory is wanted.
for stray in $(luma_stray_node_pids); do
  luma_stop_pid "$stray" "orphaned child"
done

if [ "$INCLUDE_COMFY" = 1 ]; then
  ps -A -o pid=,args= 2>/dev/null | while read -r pid args; do
    case "$args" in
    *ComfyUI*main.py*) luma_stop_pid "$pid" "ComfyUI" ;;
    esac
  done
  rm -f "$(dirname -- "$PROJECT_DIR")/run/comfy.pid"
fi
