#!/bin/bash
# Deploy the committed shim and extension into OMP's installed copy, then
# restart the shim on :8792 if the shim changed — once it is idle.
#
#   scripts/sync-to-omp.sh          deploy HEAD, whatever the branch
#   scripts/sync-to-omp.sh --hook   same, but only on main (post-commit hook)
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PKG="${OMP_PKG:-$HOME/.omp/plugins/node_modules/claude-cli-provider}"
PORT="${CLAUDE_SHIM_PORT:-8792}"

if [ "$1" = "--hook" ] && [ "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" != main ]; then
  exit 0
fi

# The commit, not the working tree: uncommitted edits never reach the live
# install. src/ goes too, so launcher changes need no plugin reinstall.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git -C "$REPO" archive HEAD shim src | tar -x -C "$STAGE"
rsync -a --delete "$STAGE/src/" "$PKG/src/"
CHANGED="$(rsync -ai --delete "$STAGE/shim/" "$PKG/shim/")"
echo "synced $(git -C "$REPO" rev-parse --short HEAD) → $PKG"

listener() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }

pid="$(listener)"
if [ -n "$pid" ] && [ -n "$CHANGED" ]; then
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  if [ "$cwd" != "$PKG/shim" ]; then
    echo "shim on :$PORT runs from ${cwd:-an unknown dir}, not this install; left running"
    exit 0
  fi
  # A restart replays every live conversation from a lossy transcript, so wait
  # until none is left (idle ones are reaped after 10 min), at most 2h.
  for _ in $(seq 480); do
    n="$(curl -sf "http://127.0.0.1:$PORT/healthz" | sed -n 's/.*"conversations":\([0-9]*\).*/\1/p')"
    [ "${n:-0}" = 0 ] && break
    sleep 15
  done
  kill "$pid"
  for _ in $(seq 20); do [ -z "$(listener)" ] && break; sleep 0.25; done
fi

# Respawn whenever nothing listens — we just stopped it, or it was already
# dead — so callers never see ConnectionRefused.
if [ -z "$(listener)" ]; then
  # node, not bun: under bun a client disconnect never reaches the shim, so
  # cancelled turns keep running.
  RUNTIME="$(command -v node || echo "${BUN:-$HOME/.bun/bin/bun}")"
  # Private log: the shim logs conversation metadata.
  (umask 077; cd "$PKG/shim" && nohup "$RUNTIME" server.mjs >> "${TMPDIR:-/tmp}/claude-shim.log" 2>&1 &)
  sleep 1.5
  [ -n "$(listener)" ] && echo "shim started" || echo "WARN: shim failed to start"
elif [ -z "$CHANGED" ]; then
  echo "shim unchanged; left running"
fi
