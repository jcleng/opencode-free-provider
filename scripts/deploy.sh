#!/usr/bin/env bash
# Sync this repo into a fixed install directory and (re)start the server there.
#
# Why: a running install in ~/.local/share/opencode-free-provider drifts out of
# sync with the repo when only the repo is updated. A stale install predating
# src/fingerprint.js relays without a valid free-tier fingerprint, and every
# chat request dies with 403 FreeTierError at the upstream gate. Run this after
# pulling or editing code so the running process always executes current code.
#
# Usage:      npm run deploy
# Override:   OFP_INSTALL_DIR=/path/to/install npm run deploy
# Port/host:  standard env overrides (PORT, HOST) are honored by server.js

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="${OFP_INSTALL_DIR:-$HOME/.local/share/opencode-free-provider}"

# Files the runtime needs. test/ and git metadata are deliberately excluded.
PAYLOAD=(server.js package.json README.md src scripts)

mkdir -p "$DST"
rm -rf "$DST/src"
tar -C "$SRC" -cf - "${PAYLOAD[@]}" | tar -C "$DST" -xf -

# Stop any process running the installed copy (cmdline may be relative
# `node server.js`, so match on the process cwd, not on argv), then start a
# fresh one detached.
python3 - "$DST" <<'PYEOF'
import glob, os, signal, sys
dst = os.path.realpath(sys.argv[1])
killed = []
for d in glob.glob('/proc/[0-9]*'):
    pid = d.split('/')[-1]
    try:
        if os.path.realpath(os.readlink(d + '/cwd')) == dst and 'server.js' in (
            open(d + '/cmdline', 'rb').read().decode('utf-8', 'replace').replace('\x00', ' ')):
            os.kill(int(pid), signal.SIGTERM)
            killed.append(pid)
    except Exception:
        pass
print(f'deploy: stopped {len(killed)} old process(es): {",".join(killed) or "none"}')
PYEOF
sleep 1

cd "$DST"
setsid nohup node server.js >> "$DST/server.log" 2>&1 < /dev/null &
echo $! > "$DST/server.pid"

# Give the process a moment to bind, then verify.
sleep 3
if ! curl -fsS -m 10 "http://${HOST:-127.0.0.1}:${PORT:-8791}/v1/models" > /dev/null; then
  echo "deploy: server did not become healthy on $HOST:$PORT — see $DST/server.log" >&2
  tail -n 20 "$DST/server.log" >&2 || true
  exit 1
fi

echo "deploy: synced $SRC -> $DST and started, healthy on port ${PORT:-8791}"
