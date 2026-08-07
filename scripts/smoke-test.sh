#!/usr/bin/env bash
# scripts/smoke-test.sh — prove a built binary actually works on this machine.
#
# A cross-compiled binary can't be run on the build host, so a successful
# build says nothing about the artifact. This is the check that
# has to happen on matching hardware before a target is published — and it is
# a script rather than prose in a workflow file so that a human testing by
# hand and CI run exactly the same thing.
#
# Usage:  scripts/smoke-test.sh <path-to-cempala-binary>
#
# It drives the real MCP protocol over stdio rather than just calling
# --version, because "the binary starts" is not the interesting failure mode.
# What matters is whether bun:sqlite opened a database, whether the stdio
# transport speaks, and whether a tool call round-trips — the things that
# actually differ across platforms.
#
# Runs entirely inside a temp HOME, so it never touches a real ~/.cempala.

set -uo pipefail

BIN="${1:-}"
if [ -z "$BIN" ]; then
  echo "usage: $0 <path-to-cempala-binary>" >&2
  exit 2
fi
if [ ! -f "$BIN" ]; then
  echo "error: no such file: $BIN" >&2
  exit 2
fi
chmod +x "$BIN" 2>/dev/null || true

WORK="$(mktemp -d 2>/dev/null || mktemp -d -t cempala-smoke)"
export HOME="$WORK/home"
mkdir -p "$HOME"
# Windows: the binary reads USERPROFILE, not HOME.
export USERPROFILE="$HOME"

cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT

failures=0
check() { # check <description> <condition-result>
  if [ "$2" = "0" ]; then
    echo "  ok    $1"
  else
    echo "  FAIL  $1"
    failures=$((failures + 1))
  fi
}

echo "smoke test: $BIN"
echo "  platform: $(uname -s) $(uname -m)"

# --- 1. Does it run at all, and is it the version we think? ---
version="$("$BIN" --version 2>/dev/null)"
echo "  version:  ${version:-<none>}"
case "$version" in
  cempala*) check "reports a version" 0 ;;
  *)        check "reports a version" 1 ;;
esac

# --- 2. --init writes a config (exercises the platform path resolution). ---
"$BIN" --init >/dev/null 2>&1
[ -f "$HOME/.cempala/config.toml" ]
check "--init writes ~/.cempala/config.toml" $?

# --- 3. Real MCP session over stdio. ---
#
# No `timeout` here: it is GNU coreutils and macOS does not ship it. A
# background watchdog is portable to the bash 3.2 that macOS does ship.
out="$WORK/out.jsonl"
err="$WORK/err.txt"

{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_message","arguments":{"from_agent":"claude","to_agent":"codex","content":"smoke-test-payload"}}}'
  echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"check_messages","arguments":{"agent_id":"codex"}}}'
  sleep 5
} | "$BIN" > "$out" 2> "$err" &
server_pid=$!

( sleep 60; kill -9 "$server_pid" 2>/dev/null ) &
watchdog_pid=$!

wait "$server_pid" 2>/dev/null
kill "$watchdog_pid" 2>/dev/null

# --- 4. Assertions on what came back. ---
grep -q '"protocolVersion"' "$out"
check "responds to initialize" $?

# All eight tools must be advertised, not merely some.
for tool in send_message check_messages create_task claim_task complete_task dispatch check_task approve_path; do
  if ! grep -q "\"$tool\"" "$out"; then
    echo "  FAIL  tools/list advertises $tool"
    failures=$((failures + 1))
    missing=1
  fi
done
[ "${missing:-0}" = "0" ]
check "tools/list advertises all 8 tools" $?

# A tool call that round-trips proves the stdio transport and bun:sqlite both
# work — the message must come back out of the database, not just go in.
grep -q 'smoke-test-payload' "$out"
check "send_message -> check_messages round-trips through sqlite" $?

[ -f "$HOME/.cempala/cempala.db" ]
check "sqlite database created" $?

# Anything on stderr from a clean run is a problem worth seeing.
if [ -s "$err" ]; then
  echo "  note  stderr was not empty:"
  sed 's/^/          /' "$err" | head -5
fi

echo ""
if [ "$failures" -eq 0 ]; then
  echo "PASS — $BIN works on $(uname -s) $(uname -m)"
  exit 0
fi
echo "FAIL — $failures check(s) failed for $BIN on $(uname -s) $(uname -m)"
exit 1
