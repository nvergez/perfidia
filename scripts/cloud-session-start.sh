#!/bin/bash
# SessionStart hook: installs workspace dependencies in Claude Code cloud sessions only.
set -euo pipefail
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi
cd "$CLAUDE_PROJECT_DIR"
echo "bun $(bun --version)"
bun install --frozen-lockfile
