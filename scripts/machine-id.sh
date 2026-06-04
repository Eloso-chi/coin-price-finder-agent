#!/usr/bin/env bash
# scripts/machine-id.sh -- print this machine's W/H identifier.
#
# Reads .machine-id at the repo root (gitignored). Used to namespace
# backlog IDs and PR titles per machine, e.g. "#264W" vs "#264H".
#
# Exit codes:
#   0  Success -- prints letter (W or H) on stdout
#   1  .machine-id missing or empty (prints setup instructions on stderr)
#   2  .machine-id contains an invalid value (must be exactly W or H)
#
# Usage:
#   MACHINE=$(scripts/machine-id.sh) || exit 1
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILE="$REPO_ROOT/.machine-id"

if [[ ! -s "$FILE" ]]; then
  cat >&2 <<EOF
[machine-id] .machine-id not found or empty at $FILE

One-time setup:
  echo W > .machine-id    # if this is the Codespace / work machine
  echo H > .machine-id    # if this is the home workstation

See docs/BACKLOG.rules.md "Per-machine ID convention" for context.
EOF
  exit 1
fi

VALUE="$(head -1 "$FILE" | tr -d '[:space:]')"

if [[ "$VALUE" != "W" && "$VALUE" != "H" ]]; then
  echo "[machine-id] invalid value in $FILE: '$VALUE' (must be exactly W or H)" >&2
  exit 2
fi

printf '%s\n' "$VALUE"
