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
#   have_claude         1/0    have_codex 1/0
#   claude_mode         ok | exists | other
#   codex_mode          ok | exists | other
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
  for cli in claude codex; do
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
}

run_installer() {
  local asset_base asset_arch asset
  case "$(uname -s)" in Darwin) asset_base=darwin ;; *) asset_base=linux ;; esac
  case "$(uname -m)" in arm64|aarch64) asset_arch=arm64 ;; *) asset_arch=x64 ;; esac
  asset="cempala-${asset_base}-${asset_arch}"

  # A deliberately minimal PATH: the stubs plus base system tools only. If the
  # developer has a real claude or codex installed, it must not be reachable,
  # or the "not found" cases would silently test nothing.
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
  claude_mode="ok"
  codex_mode="ok"
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

  # 14. A home directory with a space in it — the reason flags are passed as
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
