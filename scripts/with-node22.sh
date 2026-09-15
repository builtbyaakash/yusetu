#!/usr/bin/env bash
# Prefer Homebrew Node 22 — better-sqlite3 has no Node 26 prebuilds and
# compiling from source needs Xcode CLT.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for candidate in \
  /usr/local/opt/node@22/bin \
  /opt/homebrew/opt/node@22/bin
do
  if [[ -x "$candidate/node" ]]; then
    export PATH="$candidate:$PATH"
    break
  fi
done
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -gt 22 ]]; then
  echo "Yusetu requires Node 22 (found $(node -v))." >&2
  echo "Install: brew install node@22 && brew link --force --overwrite node@22" >&2
  echo "Or ensure /usr/local/opt/node@22/bin is on PATH." >&2
  exit 1
fi
cd "$ROOT"
exec "$@"
