#!/bin/bash
# Setup script for the Claude Code cloud environment (paste it into the environment's
# "Setup script" field). Runs as root on Ubuntu 24.04 before the session starts; cached.
# Installs Bun 1.4.3 from GitHub releases: bun.sh is not on the default network allowlist.
set -euo pipefail
BUN_VERSION=1.4.3
if command -v bun >/dev/null 2>&1 && [ "$(bun --version)" = "$BUN_VERSION" ]; then
  exit 0
fi
tmp="$(mktemp -d)"
for asset in bun-linux-x64 bun-linux-x64-baseline; do
  if curl -fsSL -o "$tmp/$asset.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$asset.zip" \
    && unzip -oq "$tmp/$asset.zip" -d "$tmp" \
    && "$tmp/$asset/bun" --version >/dev/null 2>&1; then
    install -m 0755 "$tmp/$asset/bun" /usr/local/bin/bun
    ln -sf /usr/local/bin/bun /usr/local/bin/bunx
    # Shadow any preinstalled Bun that comes earlier on PATH.
    for other in /root/.bun/bin/bun /usr/bin/bun; do
      if [ -e "$other" ] && [ "$other" != /usr/local/bin/bun ]; then ln -sf /usr/local/bin/bun "$other"; fi
    done
    break
  fi
done
rm -rf "$tmp"
test "$(/usr/local/bin/bun --version)" = "$BUN_VERSION"
