#!/bin/bash
# Sync the shim into OMP's installed copy and restart whichever shim owns :8792
# (OMP respawns it on demand; a repo-side process does not).
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)/shim"
DST="$HOME/.omp/plugins/node_modules/claude-cli-provider/shim"

rsync -a --delete "$SRC/" "$DST/"

# Restart only if the running shim is the OMP-installed copy (fresh files won't
# load until respawn). Kill it; OMP respawns from the updated copy on demand.
PIDS=$(lsof -ti :8792 2>/dev/null || true)
for pid in $PIDS; do
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | sed 's/^n//')
  case "$cwd" in
    */claude-cli-provider/shim*) kill "$pid" ;;
  esac
done

# Respawn so callers (OMP mid-session, opencode, pi) never see ConnectionRefused.
# Covers both "we just killed it" and "it was already dead before this run".
if [ -z "$(lsof -ti :8792 2>/dev/null)" ]; then
  # node, not bun: under bun a client disconnect never reaches the shim, so
  # cancelled turns keep running.
  RUNTIME="$(command -v node || echo "${BUN:-$HOME/.bun/bin/bun}")"
  (cd "$DST" && nohup "$RUNTIME" server.mjs > /tmp/claude-shim-cli.log 2>&1 &)
  sleep 1.5
  lsof -ti :8792 >/dev/null && echo "shim restarted" || echo "WARN: shim failed to start"
fi
echo "synced → $DST"