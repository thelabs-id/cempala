#!/usr/bin/env bash
# scripts/test-install.sh — exercise scripts/install.sh without touching the
# real machine.
#
# The installer is the one piece of this project that cannot be covered by the
# bun test suite, and it is also the piece every user runs first — a bug here
# is the first thing anybody sees. It has to be tested, so this drives the real
# script end to end against a stubbed world:
#
#   - a stub `curl` that serves a local fixture instead of GitHub,
#   - a throwaway $HOME, so no real ~/.cempala or rc file is touched,
#   - stub `claude` / `codex` CLIs that record their argv verbatim and whose
#     exit behaviour is scripted per case,
#   - a PATH containing only the stubs and the base system tools, so whatever
#     is installed on the developer's machine cannot change the result.
#
# IMPORTANT: run it with the OLDEST bash you support, not just your own.
# macOS still ships bash 3.2 and that is what `curl … | bash` gets there, so
# by default this runs each case under /bin/bash as well as the bash on PATH.
#
# Usage: scripts/test-install.sh

set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
installer="${here}/install.sh"

if [ ! -f "$installer" ]; then
  echo "error: cannot find $installer" >&2
  exit 2
fi

# The shells to run every case under. /bin/bash is macOS's 3.2; the one on
# PATH is whatever the developer actually has.
shells=( "/bin/bash" )
path_bash=$(command -v bash 2>/dev/null || true)
if [ -n "$path_bash" ] && [ "$path_bash" != "/bin/bash" ]; then
  shells+=( "$path_bash" )
fi

failures=0
skips=0
current_shell=""

pass() { echo "    ok    $1"; }
skip() { echo "    skip  $1"; skips=$((skips + 1)); }
fail() {
  echo "    FAIL  $1"
  if [ "$#" -gt 1 ]; then
    printf '          %s\n' "$2"
  fi
  failures=$((failures + 1))
}

# assert_contains <description> <haystack> <needle>
assert_contains() {
  case "$2" in
    *"$3"*) pass "$1" ;;
    *)      fail "$1" "expected to find: $3" ;;
  esac
}

# assert_not_contains <description> <haystack> <needle>
assert_not_contains() {
  case "$2" in
    *"$3"*) fail "$1" "should NOT have found: $3" ;;
    *)      pass "$1" ;;
  esac
}

# count_matches <file> <pattern> — how many lines match, 0 if the file is
# absent. Note `grep -c` prints 0 AND exits 1 when nothing matches, so the
# status has to be swallowed rather than turned into a second line of output.
count_matches() {
  if [ -f "$1" ]; then
    grep -c "$2" "$1" 2>/dev/null || true
  else
    echo 0
  fi
}

# assert_same_file <description> <expected-copy> <actual> — byte-exact.
# NOT "$(cat a)" = "$(cat b)": command substitution strips trailing newlines,
# so a file that gained or lost one would still compare equal.
assert_same_file() {
  if cmp -s "$2" "$3"; then
    pass "$1"
  else
    fail "$1" "$(diff "$2" "$3" 2>&1 | head -20)"
  fi
}

assert_eq() {
  if [ "$2" = "$3" ]; then
    pass "$1"
  else
    fail "$1" "expected [$3], got [$2]"
  fi
}

# --- real executables for the running-binary case ---------------------------
#
# One case needs the installed file to be genuinely EXECUTING while the
# installer replaces it. A shell script cannot produce that state — running a
# script marks no inode busy, because the kernel execs /bin/sh and sh just
# reads the file — so that case would pass regardless of what the installer
# did. It needs a real compiled binary.
#
# Borrowing a system binary does not work either: the installer runs
# `cempala --init` and aborts on a non-zero exit, and the stock utilities that
# can be made to linger (sleep, yes) reject or hang on that flag. So compile a
# throwaway that does both — exits 0 for --init, blocks for --hold.
#
# Two builds differing only in a string constant give two distinct digests, so
# the test can prove the file on disk was actually replaced.
bin_fixtures=""
compiler=""
for cc in cc gcc clang; do
  if command -v "$cc" >/dev/null 2>&1; then compiler="$cc"; break; fi
done

if [ -n "$compiler" ]; then
  bin_fixtures=$(mktemp -d)
  cat > "$bin_fixtures/stub.c" <<'C'
#include <string.h>
#include <unistd.h>
const char *build = BUILD_TAG;
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--hold") == 0) sleep(30);
  (void)build;
  return 0;
}
C
  if ! "$compiler" -DBUILD_TAG='"v1"' -o "$bin_fixtures/real-v1" "$bin_fixtures/stub.c" 2>/dev/null ||
     ! "$compiler" -DBUILD_TAG='"v2-different-length-tag"' -o "$bin_fixtures/real-v2" "$bin_fixtures/stub.c" 2>/dev/null; then
    rm -rf "$bin_fixtures"
    bin_fixtures=""
  fi
fi
hold_bin="${bin_fixtures:+$bin_fixtures/real-v1}"
next_bin="${bin_fixtures:+$bin_fixtures/real-v2}"

trap 'if [ -n "$bin_fixtures" ]; then rm -rf "$bin_fixtures"; fi' EXIT

# digest_of <file> — same tool-selection fallback as install.sh, because a
# Linux CI image may have no `shasum` and macOS has no `sha256sum`.
digest_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

# make_asset <dest> — build the stand-in release binary for this case.
make_asset() {
  if [ -n "$asset_src" ]; then
    cp "$asset_src" "$1"
  elif [ "$cempala_mode" = "ag_fail" ]; then
    # A cempala whose --register-antigravity step fails. Antigravity has no
    # `mcp add`, so that step is a call back into this very binary; if a
    # failure there aborted the run, a bad JSON config in the user's home
    # would take down an install that had otherwise fully succeeded.
    {
      printf '%s\n' '#!/bin/sh'
      printf '%s\n' 'case "$1" in'
      printf '%s\n' '  --register-antigravity) echo "boom" >&2; exit 1 ;;'
      printf '%s\n' "esac"
      printf '%s\n' "echo \"cempala stub ${payload}: \$*\""
    } > "$1"
  else
    printf '%s\n' '#!/bin/sh' "echo \"cempala stub ${payload}: \$*\"" > "$1"
  fi
  chmod +x "$1"
}

# --- the stubbed world ----------------------------------------------------
#
# Rebuilt from scratch for every case so nothing leaks between them.
#
# Variables the caller sets before calling run_installer:
#   home_dir            $HOME for the run (default: fresh dir)
#   shell_env           value of $SHELL for the run
#   payload             version string baked into the "released binary"
#   asset_src           copy this real executable instead of generating a
#                       script (needed to test replacing a RUNNING binary —
#                       see the note in that case)
#   checksum_mode       ok | mismatch | missing
#   have_claude         1/0    have_codex 1/0    have_opencode 1/0
#   claude_mode         ok | exists | other
#   codex_mode          ok | exists | other
#   opencode_mode       ok | exists | other
#
# After the run:
#   out                 merged stdout+stderr
#   rc                  exit status
#   $work/log/claude    one line per invocation, argv rendered as [a][b][c]
setup_world() {
  work=$(mktemp -d)
  mkdir -p "$work/stub" "$work/fixture" "$work/log"

  : "${home_dir:=$work/home}"
  mkdir -p "$home_dir"

  # The "release binary". Normally a script standing in for the compiled
  # cempala; asset_src swaps in a real executable when the case needs one.
  make_asset "$work/fixture/asset"

  local digest
  digest=$(digest_of "$work/fixture/asset")
  case "$checksum_mode" in
    ok)       printf '%s  %s\n' "$digest" "ASSET_NAME" > "$work/fixture/checksums.txt" ;;
    mismatch) printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "ASSET_NAME" \
                > "$work/fixture/checksums.txt" ;;
    missing)  printf '%s  %s\n' "$digest" "cempala-some-other-target" > "$work/fixture/checksums.txt" ;;
  esac

  # Stub curl. install.sh calls: curl -fsSL <url> -o <dest>
  cat > "$work/stub/curl" <<'CURL'
#!/bin/sh
url=""; dest=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) dest="$2"; shift 2 ;;
    -*) shift ;;
    *)  url="$1"; shift ;;
  esac
done
base=${url##*/}
if [ "$base" = "checksums.txt" ]; then
  # Substitute the real asset name so the fixture works on any platform.
  sed "s/ASSET_NAME/$CEMPALA_TEST_ASSET/" "$CEMPALA_TEST_FIXTURE/checksums.txt" > "$dest"
else
  cp "$CEMPALA_TEST_FIXTURE/asset" "$dest"
fi
CURL
  chmod +x "$work/stub/curl"

  # Stub agent CLIs. Each records its argv and consults its own mode.
  local cli
  for cli in claude codex opencode; do
    cat > "$work/stub/$cli" <<CLI
#!/bin/sh
name=$cli
log="\$CEMPALA_TEST_LOG/\$name"
for a in "\$@"; do printf '[%s]' "\$a"; done >> "\$log"
printf '\n' >> "\$log"

mode=\$(eval "echo \\\$CEMPALA_TEST_\$(echo \$name | tr a-z A-Z)_MODE")
adds=\$(grep -c '^\[mcp\]\[add\]' "\$log")

case "\$mode" in
  ok) exit 0 ;;
  exists)
    # First add collides; after a remove, the retry succeeds — this is how
    # claude behaves when the server is already registered.
    if [ "\$adds" -ge 2 ]; then exit 0; fi
    echo "Error: MCP server cempala already exists in user config" >&2
    exit 1 ;;
  other)
    echo "Error: config file is locked" >&2
    exit 1 ;;
esac
exit 0
CLI
    chmod +x "$work/stub/$cli"
  done

  [ "$have_claude" = "1" ] || rm -f "$work/stub/claude"
  [ "$have_codex"  = "1" ] || rm -f "$work/stub/codex"
  [ "$have_opencode" = "1" ] || rm -f "$work/stub/opencode"
}

run_installer() {
  local asset_base asset_arch asset
  case "$(uname -s)" in Darwin) asset_base=darwin ;; *) asset_base=linux ;; esac
  case "$(uname -m)" in arm64|aarch64) asset_arch=arm64 ;; *) asset_arch=x64 ;; esac
  asset="cempala-${asset_base}-${asset_arch}"

  # A deliberately minimal PATH: the stubs plus base system tools only. If the
  # developer has a real claude or codex installed, it must not be reachable,
  # or the "not found" cases would silently test nothing. The same applies to
  # opencode, which many developers working on this repo do have installed.
  out=$(
    env -i \
      HOME="$home_dir" \
      SHELL="$shell_env" \
      PATH="$work/stub:/usr/bin:/bin:/usr/sbin:/sbin" \
      CEMPALA_TEST_FIXTURE="$work/fixture" \
      CEMPALA_TEST_ASSET="$asset" \
      CEMPALA_TEST_LOG="$work/log" \
      CEMPALA_TEST_CLAUDE_MODE="$claude_mode" \
      CEMPALA_TEST_CODEX_MODE="$codex_mode" \
      CEMPALA_TEST_OPENCODE_MODE="$opencode_mode" \
      "$current_shell" "$installer" 2>&1
  )
  rc=$?
}

# publish_new_asset — regenerate the fixture (honouring the current payload /
# asset_src) and its checksum, so the next run_installer sees an upgrade.
publish_new_asset() {
  make_asset "$work/fixture/asset"
  printf '%s  %s\n' "$(digest_of "$work/fixture/asset")" "ASSET_NAME" \
    > "$work/fixture/checksums.txt"
}

# case <name> — resets every knob to its default, then the body overrides.
begin_case() {
  echo "  case: $1"
  home_dir=""
  shell_env="/bin/zsh"
  payload="v1"
  asset_src=""
  checksum_mode="ok"
  have_claude=1
  have_codex=1
  have_opencode=1
  claude_mode="ok"
  codex_mode="ok"
  opencode_mode="ok"
  cempala_mode="ok"
}

teardown() { rm -rf "$work"; }

# --- the cases ------------------------------------------------------------

run_all_cases() {

  # 1. The reported bug: `register codex "$bin"` passes no flags. On bash 3.2
  #    the empty-array expansion aborted the installer right here, after
  #    claude was registered and before codex ever was.
  begin_case "both CLIs present — registers each with the right argv"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_not_contains "no unbound-variable error" "$out" "unbound variable"
  assert_contains "claude registered" "$out" "✓ claude mcp add succeeded"
  assert_contains "codex registered" "$out" "✓ codex mcp add succeeded"
  assert_contains "closing banner printed" "$out" "✓ cempala installed."
  assert_eq "claude argv" \
    "$(cat "$work/log/claude")" \
    "[mcp][add][cempala][--scope][user][--][${home_dir:-$work/home}/.cempala/bin/cempala]"
  assert_eq "codex argv (no --scope)" \
    "$(cat "$work/log/codex")" \
    "[mcp][add][cempala][--][${home_dir:-$work/home}/.cempala/bin/cempala]"
  assert_contains "opencode registered" "$out" "✓ opencode mcp add succeeded"
  assert_eq "opencode argv (same shape as codex)" \
    "$(cat "$work/log/opencode")" \
    "[mcp][add][cempala][--][${home_dir:-$work/home}/.cempala/bin/cempala]"
  teardown

  # 1a. OpenCode used to be the one agent the installer deliberately left
  #     alone, so the case that matters is the absence of that exception:
  #     it is registered on the same terms as the others, and skipped with
  #     a manual hint when the CLI is not there — not skipped silently.
  begin_case "opencode absent — prints the manual command, install still succeeds"
  have_opencode=0
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "says it was not found" "$out" "opencode not found on PATH"
  assert_contains "prints the exact command" "$out" \
    "opencode mcp add cempala -- \"${home_dir:-$work/home}/.cempala/bin/cempala\""
  assert_contains "closing banner printed" "$out" "✓ cempala installed."
  teardown

  # 1a-ii. `opencode mcp add` updates an existing entry in place and exits 0,
  #        so re-running the installer must not go anywhere near the
  #        remove-and-retry path — there is no `opencode mcp remove` to fall
  #        back to, and calling it would print a yargs help page as an error.
  begin_case "re-running the installer re-registers opencode without a remove"
  setup_world
  run_installer
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "still succeeds" "$out" "✓ opencode mcp add succeeded"
  assert_not_contains "never called mcp remove" "$(cat "$work/log/opencode")" "[mcp][remove]"
  teardown

  # 1a-iii. opencode_mode was plumbed through with no case exercising it,
  #         so a failing `opencode mcp add` was never actually tested.
  begin_case "opencode mcp add fails — reported, install still succeeds"
  opencode_mode="other"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "the failure is reported" "$out" "opencode mcp add failed"
  assert_contains "prints the command to retry" "$out" "opencode mcp add cempala --"
  # A registration that did not take must not stop the rest of the install.
  assert_contains "closing banner printed" "$out" "✓ cempala installed."
  teardown

  # 1b. Antigravity has no `mcp add`, so it is registered by calling back
  #     into cempala itself. The absolute path matters for the same reason
  #     it does for claude/codex: a client whose PATH predates the install
  #     cannot resolve the bare name.
  begin_case "antigravity is registered via cempala --register-antigravity"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "the step ran" "$out" "registering cempala with Antigravity"
  assert_contains "with the absolute binary path" "$out" \
    "--register-antigravity ${home_dir:-$work/home}/.cempala/bin/cempala"
  assert_contains "closing banner printed" "$out" "✓ cempala installed."
  teardown

  # 1c. That step touches a file cempala does not own, so it is the step
  #     most likely to decline. Declining must not fail the install.
  begin_case "antigravity registration fails — install still succeeds"
  cempala_mode="ag_fail"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "the failure is reported" "$out" "antigravity registration step failed"
  assert_contains "and the install still completes" "$out" "✓ cempala installed."
  teardown

  # 2. Neither CLI installed: manual hints, still a success.
  begin_case "neither CLI present — prints manual commands, exits 0"
  have_claude=0; have_codex=0
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "claude hint" "$out" \
    "claude mcp add cempala --scope user -- \"$work/home/.cempala/bin/cempala\""
  assert_contains "codex hint has no stray double space" "$out" \
    "codex mcp add cempala -- \"$work/home/.cempala/bin/cempala\""
  assert_contains "closing banner printed" "$out" "✓ cempala installed."
  teardown

  # 3. FR-22: an existing registration is replaced, not left stale.
  begin_case "claude reports 'already exists' — removes and re-adds"
  claude_mode="exists"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "re-registered" "$out" "(re-registered)"
  assert_contains "remove was issued" "$(cat "$work/log/claude")" "[mcp][remove][cempala][--scope][user]"
  teardown

  # 4. An unrecognised failure must NOT delete a working registration.
  begin_case "claude fails for another reason — leaves the registration alone"
  claude_mode="other"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "reports the failure" "$out" "claude mcp add failed"
  assert_not_contains "did not remove anything" "$(cat "$work/log/claude")" "[mcp][remove]"
  assert_contains "codex still registered" "$out" "✓ codex mcp add succeeded"
  teardown

  # 5. Checksum mismatch: refuse, loudly, before installing anything.
  begin_case "checksum mismatch — aborts before installing"
  checksum_mode="mismatch"
  setup_world
  run_installer
  if [ "$rc" -ne 0 ]; then pass "exit status is non-zero"; else fail "exit status is non-zero" "got 0"; fi
  assert_contains "explains why" "$out" "sha-256 mismatch"
  if [ ! -e "$work/home/.cempala/bin/cempala" ]; then
    pass "no binary installed"
  else
    fail "no binary installed" "binary is present"
  fi
  teardown

  # 6. No line for our asset — this message was unreachable before the
  #    `|| true`, so a release cut without checksums.txt looked like a crash.
  begin_case "no checksum line for this asset — explains itself"
  checksum_mode="missing"
  setup_world
  run_installer
  if [ "$rc" -ne 0 ]; then pass "exit status is non-zero"; else fail "exit status is non-zero" "got 0"; fi
  assert_contains "explains why" "$out" "no checksum found for"
  teardown

  # 7. FR-22: re-running is safe and does not duplicate the rc line.
  begin_case "second run — idempotent PATH export, binary updated"
  setup_world
  run_installer
  assert_eq "first run succeeded" "$rc" "0"
  assert_contains "first run appended" "$out" "created $work/home/.zshrc"

  payload="v2"
  publish_new_asset
  run_installer
  assert_eq "second run succeeded" "$rc" "0"
  assert_contains "recognised the existing line" "$out" "already present"
  # Counted by MARKER, not by path: the snippet spans several lines, and the
  # marker is what the installer's own idempotency check keys on.
  assert_eq "rc block written exactly once" \
    "$(count_matches "$work/home/.zshrc" 'cempala installer')" "1"
  assert_contains "binary was replaced" "$("$work/home/.cempala/bin/cempala" --version)" "v2"
  if ls "$work/home/.cempala/bin/".cempala.new.* >/dev/null 2>&1; then
    fail "no staging file left behind" "$(ls -a "$work/home/.cempala/bin/")"
  else
    pass "no staging file left behind"
  fi
  teardown

  # 8. Replacing a binary that is currently EXECUTING — the ordinary upgrade
  #    case, since an agent normally holds cempala open as an MCP server.
  #
  #    The fixture has to be a real executable here, not the usual shell
  #    script. Running a script does not mark its inode busy — the kernel
  #    executes /bin/sh and sh merely reads the file — so a script fixture
  #    would make this case pass no matter what the installer did. The compiled
  #    fixture built at the top of this file is what actually puts the
  #    destination into the state (ETXTBSY on Linux) that staging+rename exists
  #    to survive.
  begin_case "upgrade while the installed binary is executing"
  if [ -z "$hold_bin" ]; then
    skip "no C compiler available to build a real executable fixture"
  else
    asset_src="$hold_bin"
    setup_world
    run_installer
    assert_eq "first run succeeded" "$rc" "0"

    # Genuinely execute the installed file and leave it running.
    "$work/home/.cempala/bin/cempala" --hold >/dev/null 2>&1 &
    holder=$!
    # Let the kernel actually exec it, or the upgrade races the fork.
    sleep 1
    if kill -0 "$holder" 2>/dev/null; then
      pass "installed binary is executing"
    else
      fail "installed binary is executing" "the fixture exited immediately"
    fi

    asset_src="$next_bin"
    publish_new_asset
    run_installer
    assert_eq "upgrade succeeded" "$rc" "0"
    assert_not_contains "no text-file-busy" "$out" "Text file busy"
    assert_eq "binary on disk is the new one" \
      "$(digest_of "$work/home/.cempala/bin/cempala")" "$(digest_of "$next_bin")"
    if kill -0 "$holder" 2>/dev/null; then
      pass "the running process was not disturbed"
    else
      fail "the running process was not disturbed" "it died during the upgrade"
    fi
    kill "$holder" >/dev/null 2>&1
    wait "$holder" >/dev/null 2>&1
    teardown
  fi

  # 9. rc selection: a stray ~/.zshrc must not capture a bash user's export,
  #    and bash needs BOTH a login file and ~/.bashrc — a login shell reads
  #    ~/.bash_profile and ignores ~/.bashrc, a non-login interactive shell
  #    does the reverse, and which one a terminal opens depends on the OS.
  begin_case "bash user with a stray ~/.zshrc — writes where bash actually reads"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  : > "$home_dir/.zshrc"
  shell_env="/bin/bash"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_eq "login shells covered (.bash_profile)" \
    "$(count_matches "$home_dir/.bash_profile" 'cempala installer')" "1"
  assert_eq "interactive shells covered (.bashrc)" \
    "$(count_matches "$home_dir/.bashrc" 'cempala installer')" "1"
  assert_eq "zshrc left alone" "$(count_matches "$home_dir/.zshrc" 'cempala installer')" "0"
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 10. Bash with an existing ~/.profile and no ~/.bash_profile: the login
  #     file already in use is the one to extend — creating ~/.bash_profile
  #     would SHADOW ~/.profile and silently disable whatever is in it.
  begin_case "bash with an existing ~/.profile — extends it, creates no shadow"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  echo "# existing profile" > "$home_dir/.profile"
  shell_env="/bin/bash"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_eq "profile extended" "$(count_matches "$home_dir/.profile" 'cempala installer')" "1"
  assert_contains "existing contents kept" "$(cat "$home_dir/.profile")" "# existing profile"
  if [ -f "$home_dir/.bash_profile" ]; then
    fail "no shadowing .bash_profile created" "it would hide ~/.profile from login shells"
  else
    pass "no shadowing .bash_profile created"
  fi
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 11. An existing rc for the right shell is appended to, not replaced.
  begin_case "existing ~/.zshrc — appended to, contents preserved"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  echo "# my precious config" > "$home_dir/.zshrc"
  shell_env="/bin/zsh"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "existing contents kept" "$(cat "$home_dir/.zshrc")" "# my precious config"
  assert_eq "export appended once" "$(count_matches "$home_dir/.zshrc" 'cempala installer')" "1"
  assert_eq "zsh gets exactly one file" \
    "$(count_matches "$home_dir/.zprofile" 'cempala installer')" "0"
  teardown_rc_case="$home_dir"

  # The snippet is only useful if it actually works when sourced — and because
  # bash gets two files that may source one another, sourcing it twice must
  # not stack the directory onto PATH twice.
  # Single-quoted on purpose: the inner shell must expand these, not this one.
  # shellcheck disable=SC2016
  sourced=$(env -i HOME="$home_dir" PATH="/usr/bin:/bin" /bin/sh -c \
    '. "$HOME/.zshrc"; . "$HOME/.zshrc"; echo "$PATH"')
  assert_contains "sourcing it puts cempala on PATH" "$sourced" "$home_dir/.cempala/bin"
  entries=$(printf '%s' "$sourced" | tr ':' '\n' | grep -c "^$home_dir/.cempala/bin\$" || true)
  assert_eq "sourcing twice does not duplicate the entry" "$entries" "1"

  # An empty PATH must not come back with a trailing colon: an empty component
  # in PATH means the CURRENT DIRECTORY, so that would quietly let a stray
  # executable in whatever directory you are standing in shadow a real command.
  # shellcheck disable=SC2016
  empty_path=$(env -i HOME="$home_dir" PATH="" /bin/sh -c '. "$HOME/.zshrc"; echo "$PATH"')
  assert_eq "empty PATH yields no empty component" "$empty_path" "$home_dir/.cempala/bin"
  rm -rf "$(dirname "$teardown_rc_case")"
  teardown

  # 12. Upgrading from an older installer: the line it wrote must be REPLACED,
  #     not stepped over. The marker is identical across versions, so an
  #     "already present" check alone would strand every existing user on the
  #     old unguarded line and no later fix could ever reach them.
  begin_case "rc file written by an older installer — migrated in place"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  {
    echo "# my precious config"
    echo "alias ll='ls -l'"
    echo ""
    echo "# cempala installer — added by install.sh"
    # The exact line older versions wrote.
    # shellcheck disable=SC2016
    echo 'export PATH="$HOME/.cempala/bin:$PATH"'
    echo "# something the user added afterwards"
  } > "$home_dir/.zshrc"
  shell_env="/bin/zsh"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "says what it did" "$out" "replaced the PATH export"
  # shellcheck disable=SC2016  # literals: these must not expand here
  assert_eq "old unguarded line is gone" \
    "$(count_matches "$home_dir/.zshrc" 'export PATH="\$HOME/.cempala/bin:\$PATH"')" "0"
  assert_eq "exactly one cempala block" \
    "$(count_matches "$home_dir/.zshrc" 'cempala installer')" "1"
  # shellcheck disable=SC2016
  assert_contains "new guarded snippet present" "$(cat "$home_dir/.zshrc")" \
    'PATH="$HOME/.cempala/bin${PATH:+:$PATH}"'
  assert_contains "user content above kept" "$(cat "$home_dir/.zshrc")" "alias ll='ls -l'"
  assert_contains "user content below kept" "$(cat "$home_dir/.zshrc")" "# something the user added afterwards"
  # shellcheck disable=SC2016
  migrated_path=$(env -i HOME="$home_dir" PATH="" /bin/sh -c '. "$HOME/.zshrc"; echo "$PATH"')
  assert_eq "migrated file yields a clean PATH" "$migrated_path" "$home_dir/.cempala/bin"
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 13. An rc file that is a symlink into a dotfiles repo must stay a symlink;
  #     migrating by rename would silently detach it from the repo.
  begin_case "rc file symlinked into a dotfiles repo — link preserved"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir/dotfiles"
  {
    echo "# tracked in git"
    echo "# cempala installer — added by install.sh"
    # shellcheck disable=SC2016
    echo 'export PATH="$HOME/.cempala/bin:$PATH"'
  } > "$home_dir/dotfiles/zshrc"
  ln -s "$home_dir/dotfiles/zshrc" "$home_dir/.zshrc"
  shell_env="/bin/zsh"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  if [ -L "$home_dir/.zshrc" ]; then
    pass "still a symlink"
  else
    fail "still a symlink" "the installer replaced the link with a regular file"
  fi
  # shellcheck disable=SC2016
  assert_contains "the repo copy was updated" "$(cat "$home_dir/dotfiles/zshrc")" \
    'PATH="$HOME/.cempala/bin${PATH:+:$PATH}"'
  assert_contains "tracked content kept" "$(cat "$home_dir/dotfiles/zshrc")" "# tracked in git"
  if ls "$home_dir"/.zshrc.cempala* >/dev/null 2>&1 || ls "$home_dir/dotfiles"/zshrc.cempala* >/dev/null 2>&1; then
    fail "no temp or backup files left behind" "$(ls -a "$home_dir" "$home_dir/dotfiles")"
  else
    pass "no temp or backup files left behind"
  fi
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 14. An rc file that accumulated the block TWICE — two upgrades through
  #     different installer versions. Four lines have to go, so a guard that
  #     assumed a fixed maximum would refuse the migration and silently leave
  #     BOTH unsafe exports in place.
  begin_case "rc file with two legacy blocks — both migrated"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  {
    echo "# user config"
    echo "# cempala installer — added by install.sh"
    # shellcheck disable=SC2016
    echo 'export PATH="$HOME/.cempala/bin:$PATH"'
    echo "# more user config"
    echo "# cempala installer — added by install.sh"
    # shellcheck disable=SC2016
    echo 'export PATH="$HOME/.cempala/bin:$PATH"'
  } > "$home_dir/.zshrc"
  shell_env="/bin/zsh"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "migrated rather than skipped" "$out" "replaced the PATH export"
  # shellcheck disable=SC2016
  assert_eq "both old lines gone" \
    "$(count_matches "$home_dir/.zshrc" 'export PATH="\$HOME/.cempala/bin:\$PATH"')" "0"
  assert_eq "exactly one block remains" \
    "$(count_matches "$home_dir/.zshrc" 'cempala installer')" "1"
  assert_contains "user content kept" "$(cat "$home_dir/.zshrc")" "# more user config"
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 15. A file already sitting at the backup name must not be clobbered. A
  #     predictable backup path is one the user may already be using, and the
  #     migration would overwrite it and then delete it on the way out.
  begin_case "pre-existing file at the backup name — not touched"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  {
    echo "# cempala installer — added by install.sh"
    # shellcheck disable=SC2016
    echo 'export PATH="$HOME/.cempala/bin:$PATH"'
  } > "$home_dir/.zshrc"
  echo "PLEASE DO NOT DELETE ME" > "$home_dir/.zshrc.cempala-backup"
  shell_env="/bin/zsh"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "migration still happened" "$out" "replaced the PATH export"
  if [ -f "$home_dir/.zshrc.cempala-backup" ]; then
    assert_eq "the user's file survived intact" \
      "$(cat "$home_dir/.zshrc.cempala-backup")" "PLEASE DO NOT DELETE ME"
  else
    fail "the user's file survived intact" "it was deleted"
  fi
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 16. A line that merely CONTAINS the old export — a commented-out copy —
  #     must not be mistaken for the real thing. Detection has to use the same
  #     whole-line equality the removal does, or it strips the current block's
  #     marker, finds nothing else to remove, and appends a duplicate block on
  #     every single re-run.
  begin_case "commented-out legacy line next to a current block — left alone"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  {
    echo "# an old line I keep around for reference:"
    # shellcheck disable=SC2016
    echo '# export PATH="$HOME/.cempala/bin:$PATH"'
    echo ""
    echo "# cempala installer — added by install.sh"
    # The current block, verbatim. shellcheck disable=SC2016 — literals.
    # shellcheck disable=SC2016
    echo 'case ":$PATH:" in'
    # shellcheck disable=SC2016
    echo '  *":$HOME/.cempala/bin:"*) ;;'
    # shellcheck disable=SC2016
    echo '  *) PATH="$HOME/.cempala/bin${PATH:+:$PATH}"; export PATH ;;'
    echo 'esac'
  } > "$home_dir/.zshrc"
  shell_env="/bin/zsh"
  before_rc="$(dirname "$home_dir")/rc-before"
  cp "$home_dir/.zshrc" "$before_rc"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "recognised as already current" "$out" "already present"
  assert_eq "still exactly one block" \
    "$(count_matches "$home_dir/.zshrc" 'cempala installer')" "1"
  assert_same_file "file untouched" "$before_rc" "$home_dir/.zshrc"

  # And again, to prove it does not accumulate a block per run. The second
  # run's exit status is asserted too: a run that FAILED early would also
  # leave the file untouched, and would otherwise pass these checks.
  run_installer
  assert_eq "second re-run exit status" "$rc" "0"
  assert_eq "second re-run still one block" \
    "$(count_matches "$home_dir/.zshrc" 'cempala installer')" "1"
  assert_same_file "file still untouched" "$before_rc" "$home_dir/.zshrc"
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 17. A file holding BOTH an old block and a current one — the state you get
  #     by running an old installer, then a new one, then an old one again.
  #     Removing every marker unconditionally would strip the current block's
  #     marker, orphan it, and append a third copy below.
  begin_case "rc file with both a legacy and a current block"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  {
    echo "# user config"
    echo "# cempala installer — added by install.sh"
    # shellcheck disable=SC2016
    echo 'export PATH="$HOME/.cempala/bin:$PATH"'
    echo ""
    echo "# cempala installer — added by install.sh"
    # shellcheck disable=SC2016
    echo 'case ":$PATH:" in'
    # shellcheck disable=SC2016
    echo '  *":$HOME/.cempala/bin:"*) ;;'
    # shellcheck disable=SC2016
    echo '  *) PATH="$HOME/.cempala/bin${PATH:+:$PATH}"; export PATH ;;'
    echo 'esac'
  } > "$home_dir/.zshrc"
  shell_env="/bin/zsh"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "says it replaced the old one" "$out" "replaced the PATH export"
  # shellcheck disable=SC2016
  assert_eq "the legacy export is gone" \
    "$(count_matches "$home_dir/.zshrc" 'export PATH="\$HOME/.cempala/bin:\$PATH"')" "0"
  assert_eq "exactly one marker remains" \
    "$(count_matches "$home_dir/.zshrc" '^# cempala installer')" "1"
  # shellcheck disable=SC2016  # literal regex, must not expand here
  assert_eq "exactly one guarded block remains" \
    "$(count_matches "$home_dir/.zshrc" '^case ":\$PATH:" in')" "1"
  assert_contains "user content kept" "$(cat "$home_dir/.zshrc")" "# user config"
  # shellcheck disable=SC2016
  clean_path=$(env -i HOME="$home_dir" PATH="" /bin/sh -c '. "$HOME/.zshrc"; echo "$PATH"')
  assert_eq "result still yields a clean PATH" "$clean_path" "$home_dir/.cempala/bin"
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 18. Prose that merely MENTIONS the marker must not be mistaken for the
  #     block itself, or the PATH export is never written at all — the silent
  #     failure this whole section exists to prevent.
  begin_case "a line that only mentions the marker — block still written"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  {
    echo "# note to self:"
    echo "# # cempala installer — added by install.sh  <- what that block was"
  } > "$home_dir/.zshrc"
  shell_env="/bin/zsh"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "the block was written" "$out" "appended PATH export"
  # shellcheck disable=SC2016  # literal regex, must not expand here
  assert_eq "the guarded block is there" \
    "$(count_matches "$home_dir/.zshrc" '^case ":\$PATH:" in')" "1"
  # shellcheck disable=SC2016
  clean_path=$(env -i HOME="$home_dir" PATH="" /bin/sh -c '. "$HOME/.zshrc"; echo "$PATH"')
  assert_eq "PATH actually gets set" "$clean_path" "$home_dir/.cempala/bin"
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 19. The sweep. An older installer picked the first rc file that happened to
  #     EXIST, so a bash user's block frequently landed in a stray ~/.zshrc.
  #     Upgrading writes to the right files; without the sweep the old block
  #     sits in the wrong one forever, pointing at an install that may have
  #     moved since.
  begin_case "stale block in a file we no longer write to — swept away"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  {
    echo "# zsh config a bash user still has lying around"
    echo ""
    echo "# cempala installer — added by install.sh"
    # shellcheck disable=SC2016
    echo 'export PATH="$HOME/.cempala/bin:$PATH"'
    echo "alias zz='echo hi'"
  } > "$home_dir/.zshrc"
  shell_env="/bin/bash"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "says it swept" "$out" "removed a stale cempala PATH export"
  assert_eq "the stale block is gone from .zshrc" \
    "$(count_matches "$home_dir/.zshrc" 'cempala')" "0"
  assert_contains "the rest of .zshrc survived" "$(cat "$home_dir/.zshrc")" "alias zz='echo hi'"
  assert_contains "and the first line too" "$(cat "$home_dir/.zshrc")" "# zsh config a bash user"
  assert_eq "bash's login file got the current block" \
    "$(count_matches "$home_dir/.bash_profile" 'cempala installer')" "1"
  assert_eq "so did .bashrc" \
    "$(count_matches "$home_dir/.bashrc" 'cempala installer')" "1"
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 20. The sweep must not touch a file that never had our block, and must not
  #     fire twice — a second run has nothing left to sweep.
  begin_case "sweep is idempotent and leaves unrelated files alone"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  echo "# nothing to do with cempala" > "$home_dir/.zshrc"
  cp "$home_dir/.zshrc" "$(dirname "$home_dir")/zshrc-before"
  shell_env="/bin/bash"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_not_contains "nothing was swept" "$out" "removed a stale cempala"
  assert_same_file "unrelated file untouched" \
    "$(dirname "$home_dir")/zshrc-before" "$home_dir/.zshrc"

  # Assert the login target actually HOLDS the block before claiming a re-run
  # recognised it. Without this, "already present" could be coming from
  # .bashrc alone and the byte comparison would merely confirm an empty
  # .bash_profile had not changed.
  assert_eq "login target really has the block" \
    "$(count_matches "$home_dir/.bash_profile" 'cempala installer')" "1"
  cp "$home_dir/.bash_profile" "$(dirname "$home_dir")/bp-before"
  run_installer
  assert_eq "second run exit status" "$rc" "0"
  assert_not_contains "still nothing to sweep" "$out" "removed a stale cempala"
  assert_contains "recognised as current" "$out" "already present in $home_dir/.bash_profile"
  assert_same_file "target file byte-identical on re-run" \
    "$(dirname "$home_dir")/bp-before" "$home_dir/.bash_profile"
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 21. A body whose marker is gone is LEFT ALONE. It is ordinary shell code —
  #     the same lines can appear in a heredoc, in a quoted string, or because
  #     someone wrote that export themselves — and only the marker makes a
  #     match evidence rather than a guess. The cost is a leftover block, and
  #     the cost is cosmetic: both blocks are guarded, so PATH gains the
  #     directory exactly once.
  begin_case "body with no marker — left alone, not guessed at"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  {
    echo "# user config"
    # shellcheck disable=SC2016
    echo 'case ":$PATH:" in'
    # shellcheck disable=SC2016
    echo '  *":$HOME/.cempala/bin:"*) ;;'
    # shellcheck disable=SC2016
    echo '  *) PATH="$HOME/.cempala/bin${PATH:+:$PATH}"; export PATH ;;'
    echo 'esac'
  } > "$home_dir/.zshrc"
  shell_env="/bin/zsh"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_eq "the unmarked block was not touched" \
    "$(count_matches "$home_dir/.zshrc" '^esac')" "2"
  assert_eq "and a marked one was added" \
    "$(count_matches "$home_dir/.zshrc" '^# cempala installer')" "1"
  assert_contains "user config kept" "$(cat "$home_dir/.zshrc")" "# user config"
  # The guard is what makes leaving it harmless: PATH gains the dir once.
  # shellcheck disable=SC2016
  p=$(env -i HOME="$home_dir" PATH="" /bin/sh -c '. "$HOME/.zshrc"; echo "$PATH"')
  assert_eq "PATH still has it exactly once" "$p" "$home_dir/.cempala/bin"
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 22. The same rule protects a heredoc. Documentation that happens to quote
  #     the block must survive untouched — this is the case that makes
  #     marker-only matching non-negotiable.
  begin_case "block text inside a heredoc — not touched"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  {
    echo "cempala_help() {"
    echo "  cat <<'DOC'"
    echo "What the installer adds:"
    # shellcheck disable=SC2016
    echo 'export PATH="$HOME/.cempala/bin:$PATH"'
    echo "DOC"
    echo "}"
  } > "$home_dir/.zshrc"
  cp "$home_dir/.zshrc" "$(dirname "$home_dir")/heredoc-before"
  shell_env="/bin/zsh"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  # shellcheck disable=SC2016
  assert_eq "the heredoc line survived" \
    "$(count_matches "$home_dir/.zshrc" 'export PATH="\$HOME/.cempala/bin:\$PATH"')" "1"
  assert_contains "the heredoc still closes" "$(cat "$home_dir/.zshrc")" "DOC"
  assert_eq "and the block was still added" \
    "$(count_matches "$home_dir/.zshrc" '^# cempala installer')" "1"
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 23. A file with no trailing newline must not silently gain one. Rewriting
  #     a file to remove our block should change our block and nothing else,
  #     down to the last byte.
  begin_case "rc file with no trailing newline — byte preserved"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  {
    printf '%s\n' "# cempala installer — added by install.sh"
    # shellcheck disable=SC2016
    printf '%s\n' 'export PATH="$HOME/.cempala/bin:$PATH"'
    printf '%s' "# no newline at the end of this file"
  } > "$home_dir/.zshrc"
  shell_env="/bin/bash"   # so .zshrc is SWEPT, not rewritten with a new block
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "it was swept" "$out" "removed a stale cempala"
  # 'e' is the last character of "…this file"; a trailing newline would show
  # as \n here, so this is the check that none was added.
  assert_eq "the last byte is still not a newline" \
    "$(tail -c 1 "$home_dir/.zshrc" | od -An -c | tr -d ' \n')" "e"
  assert_eq "content is exactly what remained" \
    "$(cat "$home_dir/.zshrc")" "# no newline at the end of this file"
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 24. A block written with CRLF line endings — the file has been through a
  #     Windows editor — is still recognised, and the file's other lines keep
  #     the endings they had.
  begin_case "CRLF rc file — block recognised, endings preserved"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  {
    printf '# my config\r\n'
    printf '# cempala installer — added by install.sh\r\n'
    # shellcheck disable=SC2016
    printf 'export PATH="$HOME/.cempala/bin:$PATH"\r\n'
    printf '# tail line\r\n'
  } > "$home_dir/.zshrc"
  shell_env="/bin/bash"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "the CRLF block was recognised" "$out" "removed a stale cempala"
  assert_eq "no cempala lines left" \
    "$(count_matches "$home_dir/.zshrc" 'cempala')" "0"
  # Count CR BYTES, not matching lines. The previous form flattened od's
  # output to a single line, so grep -c answered 1 whether one CR survived or
  # five — mixed or half-mangled endings would have passed.
  assert_eq "both surviving lines kept their CRLF" \
    "$(LC_ALL=C tr -cd '\r' < "$home_dir/.zshrc" | wc -c | tr -d ' ')" "2"
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 25. When the rewrite cannot be done, the file must be left exactly as it
  #     was, the installer must say so rather than claim success, and no
  #     scratch file may be left lying in the user's home directory.
  begin_case "unwritable rc file — untouched, reported, nothing left behind"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  {
    echo "# cempala installer — added by install.sh"
    # shellcheck disable=SC2016
    echo 'export PATH="$HOME/.cempala/bin:$PATH"'
  } > "$home_dir/.zshrc"
  cp "$home_dir/.zshrc" "$(dirname "$home_dir")/ro-before"
  chmod 444 "$home_dir/.zshrc"
  shell_env="/bin/zsh"
  setup_world
  run_installer
  if [ "$(id -u)" = "0" ]; then
    skip "running as root — a read-only file would not stop the write"
  else
    assert_eq "installer still succeeded overall" "$rc" "0"
    assert_contains "it said what happened" "$out" "could not update the PATH export"
    assert_same_file "the file is untouched" \
      "$(dirname "$home_dir")/ro-before" "$home_dir/.zshrc"
    if ls "$home_dir"/.zshrc.cempala* >/dev/null 2>&1; then
      fail "no scratch files left behind" "$(ls -a "$home_dir")"
    else
      pass "no scratch files left behind"
    fi
  fi
  chmod 644 "$home_dir/.zshrc"
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 26. The other half of the final-newline case: the unterminated last line is
  #     itself part of the block being removed. The line left at the end is a
  #     different one that DID end in a newline, so it must keep it — the
  #     "file had no final newline" fact belongs to the original last line, not
  #     to whichever line ends up last.
  begin_case "block at EOF with no final newline — survivor keeps its newline"
  home_dir="$(mktemp -d)/home"
  mkdir -p "$home_dir"
  {
    printf '%s\n' "# user config that ends properly"
    printf '%s\n' "# cempala installer — added by install.sh"
    # No trailing newline on the block's last line.
    # shellcheck disable=SC2016
    printf '%s' 'export PATH="$HOME/.cempala/bin:$PATH"'
  } > "$home_dir/.zshrc"
  shell_env="/bin/bash"   # so .zshrc is swept rather than rewritten
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "it was swept" "$out" "removed a stale cempala"
  assert_eq "what remains is the user's line" \
    "$(cat "$home_dir/.zshrc")" "# user config that ends properly"
  assert_eq "and it kept its trailing newline" \
    "$(tail -c 1 "$home_dir/.zshrc" | od -An -c | tr -d ' \n')" "\\n"
  rm -rf "$(dirname "$home_dir")"
  teardown

  # 27. A home directory with a space in it — the reason flags are passed as
  #     real arguments instead of one word-split string.
  begin_case "home directory containing a space"
  home_dir="$(mktemp -d)/My Home"
  mkdir -p "$home_dir"
  shell_env="/bin/zsh"
  setup_world
  run_installer
  assert_eq "exit status" "$rc" "0"
  assert_contains "installed under the spaced path" "$out" "$home_dir/.cempala/bin/cempala"
  assert_eq "claude got the path as ONE argument" \
    "$(cat "$work/log/claude")" \
    "[mcp][add][cempala][--scope][user][--][$home_dir/.cempala/bin/cempala]"
  assert_contains "closing banner printed" "$out" "✓ cempala installed."
  rm -rf "$(dirname "$home_dir")"
  teardown
}

# --- run every case under every shell -------------------------------------

echo "install.sh test suite"
for sh in "${shells[@]}"; do
  current_shell="$sh"
  echo ""
  # Single-quoted on purpose: $BASH_VERSION must be expanded by the CHILD
  # shell being reported on, not by this one.
  # shellcheck disable=SC2016
  echo "── $sh ($("$sh" -c 'echo $BASH_VERSION'))"
  run_all_cases
done

echo ""
# Skips are reported rather than swallowed: a case that quietly stopped running
# is indistinguishable from a case that passes, which is the failure mode this
# whole file exists to avoid.
if [ "$skips" -gt 0 ]; then
  echo "! $skips check(s) skipped — see 'skip' lines above"
fi
if [ "$failures" -eq 0 ]; then
  echo "✓ all install.sh checks passed"
  exit 0
fi
echo "✗ $failures check(s) failed"
exit 1
