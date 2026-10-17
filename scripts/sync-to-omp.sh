#!/bin/bash
# Deploy HEAD into an existing OMP install. Never replace live shim files
# until its conversations are idle; failed health/deadline checks abort deploy.
# --hook deploys only on main (post-commit hook).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
PKG="${OMP_PKG:-$HOME/.omp/plugins/node_modules/claude-cli-provider}"
PORT="${CLAUDE_SHIM_PORT:-8792}"
export CLAUDE_SHIM_PORT="$PORT"

if [ "${1:-}" = "--hook" ] && [ "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" != main ]; then
  exit 0
fi
for tool in node git tar rsync lsof curl; do
  command -v "$tool" >/dev/null || { echo "missing required command: $tool" >&2; exit 1; }
done
node -e 'const p=Number(process.argv[1]);if(!Number.isInteger(p)||p<1||p>65535)throw Error("CLAUDE_SHIM_PORT must be an integer from 1 to 65535")' "$PORT"
[ -d "$PKG" ] || { echo "OMP install not found: $PKG; install the plugin first" >&2; exit 1; }
PKG="$(cd "$PKG" && pwd -P)"
[ "$PKG" != "$REPO" ] || { echo "refusing to deploy over the source checkout" >&2; exit 1; }
node -e 'const p=require(process.argv[1]);if(p.name!=="claude-cli-provider")throw Error("not a claude-cli-provider install")' "$PKG/package.json"

# Stage the commit, never uncommitted working-tree edits. pipefail keeps a
# failed archive from turning into an empty rsync --delete deployment.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git -C "$REPO" archive HEAD shim src bin package.json | tar -x -C "$STAGE"
node -e '
const fs=require("node:fs");
const [next,installed]=process.argv.slice(1).map(p=>JSON.parse(fs.readFileSync(p,"utf8")));
if(JSON.stringify(next.dependencies??{})!==JSON.stringify(installed.dependencies??{}))throw Error("dependencies changed; reinstall the OMP plugin before syncing");
' "$STAGE/package.json" "$PKG/package.json"
CHANGED=""
if ! diff -qr "$STAGE/shim" "$PKG/shim" >/dev/null; then CHANGED=1; fi

listener() {
  local pids
  pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  printf '%s\n' "${pids%%$'\n'*}"
}
listener_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | while IFS= read -r line; do
    case "$line" in n*) printf '%s\n' "${line#n}" ;; esac
  done
}
conversations() {
  curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" |
    node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const h=JSON.parse(s);if(h.ok!==true||!Number.isSafeInteger(h.conversations)||h.conversations<0)throw Error();console.log(h.conversations)}catch{process.exit(1)}})'
}

pid="$(listener)"
if [ -n "$pid" ] && [ -n "$CHANGED" ]; then
  cwd="$(listener_cwd "$pid")"
  if [ "$cwd" != "$PKG/shim" ]; then
    echo "shim on :$PORT runs from ${cwd:-an unknown dir}, not this install; deploy aborted" >&2
    exit 1
  fi
  idle=0
  for _ in $(seq 480); do
    if ! n="$(conversations)"; then
      echo "cannot verify shim is idle; deploy aborted without replacing files" >&2
      exit 1
    fi
    if [ "$n" = 0 ]; then idle=1; break; fi
    sleep 15
  done
  if [ "$idle" != 1 ]; then
    echo "shim still has live conversations after 2h; deploy aborted without replacing files" >&2
    exit 1
  fi
  # Recheck ownership before signalling: another listener may have replaced it.
  [ "$(listener)" = "$pid" ] && [ "$(listener_cwd "$pid")" = "$PKG/shim" ] || { echo "listener changed; deploy aborted" >&2; exit 1; }
  kill "$pid"
  for _ in $(seq 20); do [ -z "$(listener)" ] && break; sleep 0.25; done
  [ -z "$(listener)" ] || { echo "listener did not stop; deploy aborted" >&2; exit 1; }
fi

rsync -a --delete "$STAGE/src/" "$PKG/src/"
rsync -a --delete "$STAGE/shim/" "$PKG/shim/"
rsync -a --delete "$STAGE/bin/" "$PKG/bin/"
cp "$STAGE/package.json" "$PKG/package.json"
echo "synced $(git -C "$REPO" rev-parse --short HEAD) → $PKG"

if [ -z "$(listener)" ]; then
  "$PKG/bin/claude-shim" start
elif [ -z "$CHANGED" ]; then
  echo "shim unchanged; left running"
fi
