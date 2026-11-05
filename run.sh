#!/usr/bin/env bash
# Start the eye and open the setup editor (run.ps1, for a Mac).
#   ./run.sh                 the editor opens in your browser
#   ./run.sh --open-screens  also opens every screen fullscreen on its monitor
set -euo pipefail

python="$HOME/.venvs/reel-life/bin/python"
if [[ ! -x "$python" ]]; then
    echo "No Python environment at $python. See README.md, 'First-time setup'."
    exit 1
fi

cd "$(dirname "$0")"
args=(-m eye --open-editor)
if [[ "${1:-}" == "--open-screens" ]]; then args+=(--open-screens); fi
exec "$python" "${args[@]}"
