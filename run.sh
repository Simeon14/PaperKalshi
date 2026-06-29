#!/usr/bin/env bash
#
# Launch the PaperKalshi paper-trading terminal.
#
#   ./run.sh                          # start, open a browser
#   PAPERKALSHI_PORT=9000 ./run.sh
#   PAPERKALSHI_NO_BROWSER=1 ./run.sh
#
# First run sets up the virtualenv automatically; later runs start instantly.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if ! command -v uv >/dev/null 2>&1; then
  echo "error: 'uv' is not installed. Install it from https://docs.astral.sh/uv/ and retry." >&2
  exit 1
fi

if [ ! -x ".venv/bin/paperkalshi" ]; then
  echo "First run: creating virtualenv and installing dependencies (one-time)…"
  uv venv --python 3.13
  uv pip install -e ".[dev]"
fi

exec ".venv/bin/paperkalshi"
