# Shared by the POSIX operational scripts: where the project is, which Node can
# run it, and how to stop a process without pretending TERM and KILL are the same
# signal. Sourced, never run.
#
# The scripts do not rely on their execute bit, because a checkout on Windows
# does not carry one. Invoke them as `bash scripts/start.sh`.

SCRIPTS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname -- "$SCRIPTS_DIR")"

# package.json's `engines`. node:sqlite and the bundled runtime both assume it.
NODE_MAJOR_MIN=24

luma_node_usable() {
  [ -x "$1" ] || return 1
  local major
  major="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
  [ -n "$major" ] && [ "$major" -ge "$NODE_MAJOR_MIN" ]
}

# The bundled runtime first, since on the development machine it is the only copy
# of Node that exists. It is a Windows build, though, so its presence is not a
# promise that this platform can execute it — that is why each candidate is asked
# for its version rather than merely tested for existence.
luma_node() {
  local candidate
  for candidate in \
    "$PROJECT_DIR/runtime/node/bin/node" \
    "$PROJECT_DIR/runtime/node/node" \
    "$PROJECT_DIR/runtime/node/node.exe"; do
    if luma_node_usable "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  candidate="$(command -v node 2>/dev/null)" || candidate=""
  if [ -n "$candidate" ] && luma_node_usable "$candidate"; then
    printf '%s\n' "$candidate"
    return 0
  fi
  echo "No usable Node ${NODE_MAJOR_MIN}+ found." >&2
  echo "The bundled runtime at $PROJECT_DIR/runtime/node is a Windows build; on macOS" >&2
  echo "or Linux install Node ${NODE_MAJOR_MIN}+ and put it on PATH. Do not remove runtime/." >&2
  return 1
}

# Whatever else the server spawns should find the same Node this script chose.
luma_use_node() {
  PATH="$(dirname -- "$1"):$PATH"
  export PATH
}

# Windows has no real TERM: `Stop-Process -Force` is a kill, which is exactly why
# stray MCP children outlive a stop there. Here the process is asked first and
# given time to close its own stdio children, and only then killed.
luma_stop_pid() {
  local pid="$1" label="$2" waited=0
  kill -0 "$pid" 2>/dev/null || return 1
  kill -TERM "$pid" 2>/dev/null || true
  while [ "$waited" -lt 100 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "stopped $label (pid $pid)"
      return 0
    fi
    sleep 0.1
    waited=$((waited + 1))
  done
  kill -KILL "$pid" 2>/dev/null || true
  echo "killed $label (pid $pid), which ignored SIGTERM for 10s"
}

# Whoever is listening, asked of whichever tool the platform has: lsof ships with
# macOS and is common on Linux, ss is the modern Linux answer, fuser the fallback.
luma_port_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null
  elif command -v ss >/dev/null 2>&1; then
    ss -lptnH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$port" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$'
  else
    echo "neither lsof, ss nor fuser is installed; cannot find the listener on $port" >&2
  fi
}

# Node processes running out of this directory that are not this script's own.
# `-A` rather than `-e`, which means something else entirely to BSD ps.
luma_stray_node_pids() {
  ps -A -o pid=,comm=,args= 2>/dev/null | while read -r pid comm args; do
    case "${comm##*/}" in
    node | node.exe) ;;
    *) continue ;;
    esac
    case "$args" in
    *"$PROJECT_DIR"*) ;;
    *) continue ;;
    esac
    if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then continue; fi
    printf '%s\n' "$pid"
  done
}
