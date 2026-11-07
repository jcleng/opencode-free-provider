#!/usr/bin/env bash
# Sync this repo into a fixed install directory and (re)start the server there.
#
# Why: a running install in ~/.local/share/opencode-free-provider drifts out of
# sync with the repo when only the repo is updated. A stale install predating
# src/fingerprint.js relays without a valid free-tier fingerprint, and every
# chat request dies with 403 FreeTierError at the upstream gate. Run this after
# pulling or editing code so the running process always executes current code.
#
# The server is started with BUN when available: the free tier fingerprints the
# outbound TLS client hello, and Node/OpenSSL is answered with
# 429 FreeUsageLimitError even when the egress IP still has free quota.
#
# Usage:      npm run deploy
# Override:   OFP_INSTALL_DIR=/path/to/install npm run deploy
# Port/host:  standard env overrides (PORT, HOST) are honored by server.js

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="${OFP_INSTALL_DIR:-$HOME/.local/share/opencode-free-provider}"

# Files the runtime needs. test/ and git metadata are deliberately excluded.
PAYLOAD=(server.js package.json README.md src)

mkdir -p "$DST"
rm -rf "$DST/src"
tar -C "$SRC" -cf - "${PAYLOAD[@]}" | tar -C "$DST" -xf -

# Stop any process running the installed copy, then start a fresh one.
pkill -f "$DST/server.js" 2>/dev/null || true
sleep 1

cd "$DST"
if command -v bun >/dev/null 2>&1; then
  setsid nohup bun server.js >> "$DST/server.log" 2>&1 < /dev/null &
else
  echo "deploy: WARNING: bun not found — falling back to node." >&2
  echo "deploy: Node's TLS client hello is rejected by the free tier (429 FreeUsageLimitError even with quota left)." >&2
  setsid nohup node server.js >> "$DST/server.log" 2>&1 < /dev/null &
fi

# Give the process a moment to bind, then verify.
sleep 3
if ! curl -fsS -m 10 "http://${HOST:-127.0.0.1}:${PORT:-8791}/v1/models" > /dev/null; then
  echo "deploy: server did not become healthy on $HOST:$PORT — see $DST/server.log" >&2
  tail -n 20 "$DST/server.log" >&2 || true
  exit 1
fi

echo "deploy: synced $SRC -> $DST and started, healthy on port ${PORT:-8791}"
