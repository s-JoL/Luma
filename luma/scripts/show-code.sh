#!/usr/bin/env bash
# POSIX counterpart of show-code.ps1. Prints the access code from the encrypted
# vault.
set -uo pipefail

# shellcheck source=scripts/common.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

NODE="$(luma_node)" || exit 1
luma_use_node "$NODE"

cd "$PROJECT_DIR" || exit 1
CODE="$("$NODE" --import tsx scripts/access-code.ts)"
echo
echo "Access code: $CODE"
echo
