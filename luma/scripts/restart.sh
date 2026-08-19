#!/usr/bin/env bash
# POSIX counterpart of restart.ps1. Development loop: foreground server on the
# audit instance, no tunnel and no build. The data directory defaults to
# `data-audit` — the configuration-only clone from `audit-db.ts --clone` — so a
# test run never writes the real transcript. For real use run start.sh instead.
#
#   --port N          listening port (default 8095)
#   --access-code C   throwaway access code (default AUDITCODE)
#   --data-dir D      data directory, absolute or relative to the project
set -uo pipefail

# shellcheck source=scripts/common.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

PORT=8095
ACCESS_CODE=AUDITCODE
DATA_DIR=data-audit
while [ "$#" -gt 0 ]; do
  case "$1" in
  --port)
    PORT="$2"
    shift 2
    ;;
  --access-code)
    ACCESS_CODE="$2"
    shift 2
    ;;
  --data-dir)
    DATA_DIR="$2"
    shift 2
    ;;
  *)
    echo "unknown argument: $1" >&2
    exit 2
    ;;
  esac
done

NODE="$(luma_node)" || exit 1
luma_use_node "$NODE"

export LUMA_PORT="$PORT"
export LUMA_ACCESS_CODE="$ACCESS_CODE"
case "$DATA_DIR" in
/*) export LUMA_DATA_DIR="$DATA_DIR" ;;
*) export LUMA_DATA_DIR="$PROJECT_DIR/$DATA_DIR" ;;
esac

if [ ! -d "$LUMA_DATA_DIR" ]; then
  echo "no $DATA_DIR yet — run: node --import tsx scripts/audit-db.ts --clone"
  exit 1
fi

for owner in $(luma_port_pids "$PORT"); do
  luma_stop_pid "$owner" "listener on $PORT"
done
sleep 0.6

cd "$PROJECT_DIR" || exit 1
exec "$NODE" --import tsx src/server/main.ts
