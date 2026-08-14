#!/usr/bin/env bash
# scripts/test-uninstall.sh — end-to-end tests for uninstall.sh
#
# The unit tests cover the pure matcher and the Antigravity JSON edit. They
# say nothing about the script that orchestrates them, and that script
# edits shell startup files, calls other people's CLIs, and can be asked to
# delete the database — so "the pieces work" is not the same claim as "the
# uninstaller works".
#
# Everything here runs against a throwaway $HOME with stub `claude` and
# `codex` on PATH, so no real config is touched. As with test-install.sh,
# every case runs under /bin/bash as well as the bash on PATH: macOS still
# ships bash 3.2, which is what the documented one-line install gets there,
# and it differs in ways that have already caused real bugs (an empty array
# expanded under `set -u` is an error rather than nothing).

set -uo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
failures=0
checks=0

pass() { checks=$((checks+1)); echo "    ok    $1"; }
fail() {
  checks=$((checks+1)); failures=$((failures+1))
  echo "    FAIL  $1"
  [ "$#" -gt 1 ] && echo "          $2"
}
assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected [$3], got [$2]"; fi
}
assert_contains() {
  case "$2" in *"$3"*) pass "$1" ;; *) fail "$1" "missing [$3]" ;; esac
}
assert_not_contains() {
  case "$2" in *"$3"*) fail "$1" "should not contain [$3]" ;; *) pass "$1" ;; esac
}

# --- a compiled cempala to test against -------------------------------------
#
# The uninstaller delegates the two delicate steps to the binary, so a stub
# shell script would test almost nothing. Build the real thing once.
bun_bin=$(command -v bun || true)
if [ -z "$bun_bin" ]; then
  echo "error: bun is required to build the binary these tests exercise" >&2
  exit 1
fi
real_bin=$(mktemp -d)/cempala
echo "→ building cempala for the tests"
(cd "$repo_root" && bun build --compile src/index.ts --outfile "$real_bin" >/dev/null 2>&1) || {
  echo "error: could not build cempala" >&2; exit 1
}

work=""
cleanup_work() { [ -n "$work" ] && rm -rf "$work"; }
trap 'cleanup_work; rm -rf "$(dirname "$real_bin")"' EXIT

RC_MARKER='# cempala installer — added by install.sh'

# setup_world — a throwaway HOME that looks like a real install.
#
# $have_binary, $rc_contents, $ag_contents and $oc_contents are set by each
# case before calling this.
setup_world() {
  cleanup_work
  work=$(mktemp -d)
  export FAKE_HOME="$work/home"
  mkdir -p "$FAKE_HOME/.cempala/bin" "$FAKE_HOME/.gemini/config" \
           "$FAKE_HOME/.config/opencode" "$work/stub" "$work/log"

  if [ "${have_binary:-1}" = "1" ]; then
    cp "$real_bin" "$FAKE_HOME/.cempala/bin/cempala"
  fi

  # A database and config, so we can prove --purge is the only thing that
  # removes them.
  echo "fake sqlite" > "$FAKE_HOME/.cempala/cempala.db"
  echo "# config"   > "$FAKE_HOME/.cempala/config.toml"

  printf '%s' "${rc_contents:-}" > "$FAKE_HOME/.zshrc"
  printf '%s' "${ag_contents:-}" > "$FAKE_HOME/.gemini/config/mcp_config.json"

  # OpenCode's config is only created when a case asks for one: "no config
  # at all" is the common real state and has its own expected message.
  #
  # Cleared once used, unlike the knobs above, because it is the only one
  # cases do NOT all set explicitly — and a stale value here is not an
  # inert fixture. It plants a live cempala registration in a case that
  # believes nothing is installed, which the uninstaller then correctly
  # reports as a failed cleanup, failing an assertion that was right all
  # along.
  if [ -n "${oc_contents:-}" ]; then
    printf '%s' "$oc_contents" > "$FAKE_HOME/.config/opencode/opencode.jsonc"
    oc_contents=""
  fi

  # Stub agent CLIs that record their argv. `mcp remove` succeeds; anything
  # else is irrelevant here.
  for cli in claude codex; do
    cat > "$work/stub/$cli" <<STUB
#!/bin/sh
printf '[%s]' "\$@" >> "$work/log/$cli"
echo "" >> "$work/log/$cli"
exit 0
STUB
    chmod +x "$work/stub/$cli"
  done
}

# run_uninstall [args...] — run the script under one bash, capture output.
run_uninstall() {
  # XDG_CONFIG_HOME is unset rather than inherited: it is what decides
  # where OpenCode's config lives, for uninstall.sh AND for the binary it
  # calls, so a developer who has it set would otherwise send these cases
  # looking at their own real config.
  out=$(env -u XDG_CONFIG_HOME \
        HOME="$FAKE_HOME" PATH="$work/stub:/usr/bin:/bin:/usr/sbin:/sbin" \
        "$bash_bin" "$repo_root/scripts/uninstall.sh" "$@" 2>&1)
  rc=$?
}

# Single-quoted on purpose: these are the literal bytes of a shell startup
# file, and $PATH / $HOME must reach it UNEXPANDED, exactly as install.sh
# writes them.
# shellcheck disable=SC2016
INSTALLED_RC='export EDITOR=vim
alias ll="ls -la"

# cempala installer — added by install.sh
case ":$PATH:" in
  *":$HOME/.cempala/bin:"*) ;;
  *) PATH="$HOME/.cempala/bin${PATH:+:$PATH}"; export PATH ;;
esac
'
CLEAN_RC='export EDITOR=vim
alias ll="ls -la"
'
AG_WITH_CEMPALA='{
  "mcpServers": {
    "sqlite-explorer": { "command": "node" },
    "cempala": { "command": "/home/x/.cempala/bin/cempala" }
  },
  "keepMe": true
}
'

OC_WITH_CEMPALA='{
  // hand-written, and it stays that way
  "$schema": "https://opencode.ai/config.json",
  "theme": "tokyonight",
  "mcp": {
    "sqlite-explorer": { "type": "local", "command": ["node"] },
    "cempala": { "type": "local", "command": ["/home/x/.cempala/bin/cempala"] }
  }
}
'

run_all_cases() {
  # --- the happy path ------------------------------------------------------
  echo "  case: full uninstall removes all five, keeps data"
  have_binary=1 rc_contents="$INSTALLED_RC" ag_contents="$AG_WITH_CEMPALA" oc_contents="$OC_WITH_CEMPALA"
  setup_world; run_uninstall
  assert_eq "exit status" "$rc" "0"
  assert_contains "reports success" "$out" "✓ cempala uninstalled."
  assert_eq "rc file back to its pre-install contents" "$(cat "$FAKE_HOME/.zshrc")" "$(printf '%s' "$CLEAN_RC")"
  assert_not_contains "cempala gone from the antigravity config" "$(cat "$FAKE_HOME/.gemini/config/mcp_config.json")" '"cempala"'
  assert_contains "the other server survived" "$(cat "$FAKE_HOME/.gemini/config/mcp_config.json")" "sqlite-explorer"
  assert_contains "unrelated settings survived" "$(cat "$FAKE_HOME/.gemini/config/mcp_config.json")" "keepMe"
  oc_after=$(cat "$FAKE_HOME/.config/opencode/opencode.jsonc")
  assert_not_contains "cempala gone from the opencode config" "$oc_after" '"cempala"'
  assert_contains "the other opencode server survived" "$oc_after" "sqlite-explorer"
  assert_contains "the user's comment survived" "$oc_after" "hand-written, and it stays that way"
  assert_contains "unrelated opencode settings survived" "$oc_after" "tokyonight"
  assert_contains "claude was asked to remove" "$(cat "$work/log/claude")" "[mcp][remove][cempala][--scope][user]"
  assert_contains "codex was asked to remove" "$(cat "$work/log/codex")" "[mcp][remove][cempala]"
  if [ -f "$FAKE_HOME/.cempala/bin/cempala" ]; then fail "binary removed"; else pass "binary removed"; fi
  if [ -f "$FAKE_HOME/.cempala/cempala.db" ]; then pass "database KEPT by default"; else fail "database KEPT by default"; fi

  # --- data is only removed on request -------------------------------------
  echo "  case: --purge removes the data directory"
  have_binary=1 rc_contents="$INSTALLED_RC" ag_contents="$AG_WITH_CEMPALA"
  setup_world; run_uninstall --purge
  assert_eq "exit status" "$rc" "0"
  if [ -d "$FAKE_HOME/.cempala" ]; then fail "data directory removed"; else pass "data directory removed"; fi

  # --- dry run -------------------------------------------------------------
  echo "  case: --dry-run changes absolutely nothing"
  have_binary=1 rc_contents="$INSTALLED_RC" ag_contents="$AG_WITH_CEMPALA"
  setup_world
  before_rc=$(cat "$FAKE_HOME/.zshrc"); before_ag=$(cat "$FAKE_HOME/.gemini/config/mcp_config.json")
  run_uninstall --dry-run
  assert_eq "exit status" "$rc" "0"
  assert_eq "rc file untouched" "$(cat "$FAKE_HOME/.zshrc")" "$before_rc"
  assert_eq "antigravity config untouched" "$(cat "$FAKE_HOME/.gemini/config/mcp_config.json")" "$before_ag"
  if [ -f "$FAKE_HOME/.cempala/bin/cempala" ]; then pass "binary untouched"; else fail "binary untouched"; fi
  if [ -f "$work/log/claude" ]; then fail "no CLI was actually invoked"; else pass "no CLI was actually invoked"; fi

  # --- idempotence ---------------------------------------------------------
  echo "  case: running twice is safe and says nothing alarming"
  have_binary=1 rc_contents="$INSTALLED_RC" ag_contents="$AG_WITH_CEMPALA"
  setup_world; run_uninstall; run_uninstall
  assert_eq "second run still exits 0" "$rc" "0"
  assert_contains "no PATH export left to remove" "$out" "no cempala PATH export found"
  assert_not_contains "does not warn about stripping" "$out" "cannot strip the PATH export"

  # --- a machine that never had cempala ------------------------------------
  echo "  case: nothing installed at all"
  have_binary=0 rc_contents="$CLEAN_RC" ag_contents='{"mcpServers":{}}'
  setup_world; run_uninstall
  assert_eq "exit status" "$rc" "0"
  assert_eq "rc file untouched" "$(cat "$FAKE_HOME/.zshrc")" "$(printf '%s' "$CLEAN_RC")"

  # --- the file is not ours to edit ----------------------------------------
  echo "  case: a hand-edited block is left alone and reported"
  have_binary=1 ag_contents='{"mcpServers":{}}'
  rc_contents="${RC_MARKER}
export PATH=\"\$HOME/somewhere/else:\$PATH\"
"
  setup_world
  before_rc=$(cat "$FAKE_HOME/.zshrc")
  run_uninstall
  assert_eq "edited block left byte-identical" "$(cat "$FAKE_HOME/.zshrc")" "$before_rc"

  # --- a failure must not be reported as success ---------------------------
  echo "  case: an unwritable rc file yields a PARTIAL uninstall, and keeps the binary"
  have_binary=1 rc_contents="$INSTALLED_RC" ag_contents='{"mcpServers":{}}'
  setup_world
  chmod 500 "$FAKE_HOME"          # can read/rewrite .zshrc, cannot create a backup beside it
  run_uninstall
  chmod 700 "$FAKE_HOME"
  assert_eq "exit status is non-zero" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
  assert_contains "says it was partial" "$out" "PARTIALLY uninstalled"
  assert_not_contains "does NOT claim success" "$out" "✓ cempala uninstalled."
  if [ -f "$FAKE_HOME/.cempala/bin/cempala" ]; then
    pass "binary KEPT so the user can retry"
  else
    fail "binary KEPT so the user can retry"
  fi
  assert_contains "rc file still has its block" "$(cat "$FAKE_HOME/.zshrc")" "cempala installer"

  # --- an old binary that does not know the flags --------------------------
  echo "  case: a binary too old for the flags prints manual instructions"
  have_binary=1 rc_contents="$INSTALLED_RC" ag_contents="$AG_WITH_CEMPALA"
  setup_world
  printf '#!/bin/sh\necho "cempala 0.1.0"\n' > "$FAKE_HOME/.cempala/bin/cempala"
  chmod +x "$FAKE_HOME/.cempala/bin/cempala"
  run_uninstall
  assert_contains "names the file to edit by hand" "$out" "$FAKE_HOME/.zshrc"
  assert_contains "explains the antigravity entry" "$out" "mcpServers"
  assert_contains "rc file untouched" "$(cat "$FAKE_HOME/.zshrc")" "cempala installer"
  # Instructions printed is not the same as work done. Live config left
  # behind has to make the run a failure, or --purge would go on to delete
  # the database while Antigravity still pointed at the binary.
  assert_eq "exit status is non-zero" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
  assert_contains "says it was partial" "$out" "PARTIALLY uninstalled"
  assert_not_contains "does NOT claim success" "$out" "✓ cempala uninstalled."

  echo "  case: --purge with an old binary does NOT delete the database"
  have_binary=1 rc_contents="$INSTALLED_RC" ag_contents="$AG_WITH_CEMPALA"
  setup_world
  printf '#!/bin/sh\necho "cempala 0.1.0"\n' > "$FAKE_HOME/.cempala/bin/cempala"
  chmod +x "$FAKE_HOME/.cempala/bin/cempala"
  run_uninstall --purge
  assert_eq "exit status is non-zero" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
  assert_contains "says it did not purge" "$out" "NOT purging"
  assert_contains "says it was partial" "$out" "PARTIALLY uninstalled"
  if [ -f "$FAKE_HOME/.cempala/cempala.db" ]; then
    pass "the database survived"
  else
    fail "the database survived"
  fi

  echo "  case: no binary at all, with residue left behind"
  have_binary=0 rc_contents="$INSTALLED_RC" ag_contents="$AG_WITH_CEMPALA"
  setup_world
  run_uninstall
  assert_eq "exit status is non-zero" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
  # It must not claim to have kept a binary that was never there.
  assert_contains "says it was partial" "$out" "PARTIALLY uninstalled"
  assert_not_contains "does NOT claim success" "$out" "✓ cempala uninstalled."
  assert_not_contains "does not claim a missing binary was kept" "$out" "The binary was kept"
  assert_contains "explains it must be finished by hand" "$out" "by hand"

  # --- symlinked rc file ---------------------------------------------------
  echo "  case: a dotfiles-symlinked rc file stays a symlink"
  have_binary=1 rc_contents="" ag_contents='{"mcpServers":{}}'
  setup_world
  mkdir -p "$FAKE_HOME/dotfiles"
  printf '%s' "$INSTALLED_RC" > "$FAKE_HOME/dotfiles/zshrc"
  rm -f "$FAKE_HOME/.zshrc"
  ln -s "$FAKE_HOME/dotfiles/zshrc" "$FAKE_HOME/.zshrc"
  run_uninstall
  if [ -L "$FAKE_HOME/.zshrc" ]; then pass "still a symlink"; else fail "still a symlink"; fi
  assert_eq "the dotfiles file itself was edited" "$(cat "$FAKE_HOME/dotfiles/zshrc")" "$(printf '%s' "$CLEAN_RC")"

  # --- OpenCode ------------------------------------------------------------
  #
  # OpenCode is the newest of the four registrations and the only one the
  # installer adds through a CLI it cannot also use to remove, so these
  # cases exist to prove the removal half really is covered.

  echo "  case: no opencode config at all is not a failure"
  have_binary=1 rc_contents="$CLEAN_RC" ag_contents='{"mcpServers":{}}' oc_contents=""
  setup_world
  run_uninstall
  assert_eq "exit status" "$rc" "0"
  assert_contains "says there was nothing to remove" "$out" "not registered in"
  assert_contains "reports success" "$out" "✓ cempala uninstalled."

  echo "  case: an opencode config without cempala is left byte-identical"
  have_binary=1 rc_contents="$CLEAN_RC" ag_contents='{"mcpServers":{}}'
  oc_contents='{
  // someone else entirely
  "mcp": { "other": { "type": "local", "command": ["/usr/bin/other"] } }
}
'
  setup_world
  before_oc=$(cat "$FAKE_HOME/.config/opencode/opencode.jsonc")
  run_uninstall
  assert_eq "exit status" "$rc" "0"
  assert_eq "left byte-identical" "$(cat "$FAKE_HOME/.config/opencode/opencode.jsonc")" "$before_oc"

  echo "  case: an unparseable opencode config is refused, and that is a FAILURE"
  have_binary=1 rc_contents="$CLEAN_RC" ag_contents='{"mcpServers":{}}'
  oc_contents='{ "mcp": { "cempala": { "command": '
  setup_world
  before_oc=$(cat "$FAKE_HOME/.config/opencode/opencode.jsonc")
  run_uninstall
  assert_eq "left byte-identical" "$(cat "$FAKE_HOME/.config/opencode/opencode.jsonc")" "$before_oc"
  assert_contains "names the file to fix" "$out" "opencode.jsonc"
  # Same rule as Antigravity: a removal we declined is live configuration
  # left behind, so the run must not end under a success banner.
  assert_eq "exit status is non-zero" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
  assert_contains "says it was partial" "$out" "PARTIALLY uninstalled"
  assert_eq "the binary was kept so the step can be retried" \
    "$([ -f "$FAKE_HOME/.cempala/bin/cempala" ] && echo yes || echo no)" "yes"

  echo "  case: one clean config and one unparseable legacy config"
  # Decides whether the .some() over per-file outcomes in index.ts is right:
  # the clean file must still be cleaned, and the run must still fail.
  have_binary=1 rc_contents="$CLEAN_RC" ag_contents='{"mcpServers":{}}' oc_contents="$OC_WITH_CEMPALA"
  setup_world
  printf '%s' '{ "mcp": { "cempala": ' > "$FAKE_HOME/.config/opencode/config.json"
  run_uninstall
  assert_not_contains "the parseable config was still cleaned" \
    "$(cat "$FAKE_HOME/.config/opencode/opencode.jsonc")" '"cempala"'
  assert_eq "the malformed one is untouched" \
    "$(cat "$FAKE_HOME/.config/opencode/config.json")" '{ "mcp": { "cempala": '
  assert_eq "exit status is non-zero" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
  assert_contains "says it was partial" "$out" "PARTIALLY uninstalled"

  echo "  case: a malformed config with no cempala in it does NOT fail the uninstall"
  # Two of the three files cempala never writes, so a user's broken legacy
  # config must not turn a clean uninstall into a partial one.
  have_binary=1 rc_contents="$CLEAN_RC" ag_contents='{"mcpServers":{}}' oc_contents=""
  setup_world
  printf '%s' '{ "theme": [[[ }' > "$FAKE_HOME/.config/opencode/config.json"
  run_uninstall
  assert_eq "exit status" "$rc" "0"
  assert_contains "reports success" "$out" "✓ cempala uninstalled."

  echo "  case: a binary too old to know --unregister-opencode reports it as a failure"
  # The upgrade path that actually happens: uninstall.sh is fetched from
  # main while the installed binary predates the flag. It must not silently
  # skip the step and delete the binary that was the only way to do it.
  have_binary=1 rc_contents="$CLEAN_RC" ag_contents='{"mcpServers":{}}' oc_contents="$OC_WITH_CEMPALA"
  setup_world
  cat > "$FAKE_HOME/.cempala/bin/cempala" <<'OLD'
#!/bin/sh
# An older cempala: --help lists no opencode flag, and an unknown flag is
# not rejected — it would start the MCP server and read stdin.
if [ "$1" = "--help" ]; then
  echo "  cempala --unregister-antigravity"
  exit 0
fi
exit 0
OLD
  chmod +x "$FAKE_HOME/.cempala/bin/cempala"
  run_uninstall
  assert_contains "says the build cannot do it" "$out" "cannot unregister itself from OpenCode"
  assert_contains "names the file" "$out" "opencode.jsonc"
  assert_eq "exit status is non-zero" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
  assert_contains "says it was partial" "$out" "PARTIALLY uninstalled"

  # --- an unparseable antigravity config -----------------------------------
  echo "  case: an unparseable antigravity config is refused, and that is a FAILURE"
  have_binary=1 rc_contents="$CLEAN_RC"
  ag_contents='{"mcpServers": {"important": {"command": "keepme"},}}'
  setup_world
  before_ag=$(cat "$FAKE_HOME/.gemini/config/mcp_config.json")
  run_uninstall
  assert_eq "left byte-identical" "$(cat "$FAKE_HOME/.gemini/config/mcp_config.json")" "$before_ag"
  assert_contains "says why" "$out" "not valid JSON"
  # A refusal we cannot complete is not a success. Reporting one here let
  # the binary be deleted while a live registration still pointed at it.
  assert_eq "exit status is non-zero" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
  assert_contains "says it was partial" "$out" "PARTIALLY uninstalled"
  if [ -f "$FAKE_HOME/.cempala/bin/cempala" ]; then
    pass "binary KEPT so the user can retry"
  else
    fail "binary KEPT so the user can retry"
  fi

  # --- a failing agent CLI -------------------------------------------------
  echo "  case: a CLI that fails to unregister makes the uninstall partial"
  have_binary=1 rc_contents="$CLEAN_RC" ag_contents='{"mcpServers":{}}'
  setup_world
  # A claude whose `mcp remove` fails for a reason that is NOT "already gone".
  cat > "$work/stub/claude" <<'STUB'
#!/bin/sh
echo "error: config file is locked" >&2
exit 1
STUB
  chmod +x "$work/stub/claude"
  run_uninstall
  assert_eq "exit status is non-zero" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
  assert_contains "tells the user the command to run" "$out" "mcp remove cempala"
  assert_contains "says it was partial" "$out" "PARTIALLY uninstalled"
  if [ -f "$FAKE_HOME/.cempala/bin/cempala" ]; then
    pass "binary KEPT so the user can retry"
  else
    fail "binary KEPT so the user can retry"
  fi

  echo "  case: a CLI reporting 'no such server' is NOT a failure"
  have_binary=1 rc_contents="$CLEAN_RC" ag_contents='{"mcpServers":{}}'
  setup_world
  cat > "$work/stub/claude" <<'STUB'
#!/bin/sh
echo "No MCP server named cempala" >&2
exit 1
STUB
  chmod +x "$work/stub/claude"
  run_uninstall
  assert_eq "exit status" "$rc" "0"
  assert_contains "reports success" "$out" "✓ cempala uninstalled."

  # --- purge must not run over the top of a failure ------------------------
  echo "  case: --purge is SKIPPED when a step failed, so data survives"
  have_binary=1 rc_contents="$CLEAN_RC"
  ag_contents='{"mcpServers": {"important": {"command": "keepme"},}}'
  setup_world
  run_uninstall --purge
  assert_eq "exit status is non-zero" "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
  assert_contains "says it did not purge" "$out" "NOT purging"
  assert_contains "says it was partial" "$out" "PARTIALLY uninstalled"
  assert_not_contains "does NOT claim success" "$out" "✓ cempala uninstalled."
  if [ -f "$FAKE_HOME/.cempala/cempala.db" ]; then
    pass "the database survived a failed purge"
  else
    fail "the database survived a failed purge"
  fi
  if [ -f "$FAKE_HOME/.cempala/bin/cempala" ]; then
    pass "the binary survived, so a retry is possible"
  else
    fail "the binary survived, so a retry is possible"
  fi
}

echo "uninstall.sh test suite"
for bash_bin in /bin/bash "$(command -v bash)"; do
  [ -x "$bash_bin" ] || continue
  # Skip the duplicate when PATH bash IS /bin/bash.
  if [ "$bash_bin" != "/bin/bash" ] && [ "$(readlink -f "$bash_bin" 2>/dev/null || echo "$bash_bin")" = "/bin/bash" ]; then
    continue
  fi
  echo ""
  echo "── $bash_bin ($("$bash_bin" --version | head -1 | sed 's/.*version //;s/ .*//'))"
  run_all_cases
done

echo ""
if [ "$failures" -eq 0 ]; then
  echo "✓ all uninstall.sh checks passed ($checks checks)"
  exit 0
fi
echo "✗ $failures of $checks checks failed"
exit 1
