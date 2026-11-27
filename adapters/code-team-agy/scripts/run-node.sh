#!/usr/bin/env sh
set -eu

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.asdf/shims/node"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  if [ -d "$HOME/.nvm/versions/node" ]; then
    # Pick the newest installed nvm node version
    latest="$(ls -1d "$HOME/.nvm/versions/node"/v*/bin/node 2>/dev/null | sort -V | tail -n 1 || true)"
    if [ -n "$latest" ] && [ -x "$latest" ]; then
      printf '%s\n' "$latest"
      return 0
    fi
  fi
  return 1
}

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  printf '%s\n' '{"decision":"allow","reason":"code-team-agy: node binary not found; hook skipped"}'
  exit 0
fi

exec "$NODE_BIN" "$@"
