#!/usr/bin/env bash
# scripts/uninstall.sh — cempala uninstaller for macOS / Linux
#
# The counterpart to install.sh, and it exists because deleting
# `~/.cempala/` was never enough. The installer writes to four places, and
# three of them are other programs' config files:
#
#   1. ~/.cempala/            the binary, the config, the database
#   2. a shell startup file   the PATH export
#   3. Claude Code and Codex  an MCP server registration each
#   4. Antigravity            an entry in ~/.gemini/config/mcp_config.json
#
# Remove only (1) and the three registrations survive, each pointing at a
# binary that no longer exists — so every launch of every agent CLI reports
# cempala as a failed server, indefinitely, and the user has to go find
# three config files to stop it. Undoing an install has to undo all four.
#
# Two rules shape everything below:
#
#   - Registrations are removed with each CLI's OWN tool (`claude mcp
#     remove`, `codex mcp remove`) so their config files stay theirs to
#     edit. Only Antigravity, which ships no such command, is edited
#     directly — by the binary, which removes one key and leaves the rest
#     of the file alone.
#
#   - YOUR DATA IS KEPT unless you ask for it to go. `~/.cempala/` holds
#     the task history and the audit log; that is a record, not
#     installation debris, and uninstalling the software is not a
#     instruction to discard it. `--purge` removes it, and says so first.
#
# Usage:
#   bash uninstall.sh            remove the install, keep ~/.cempala/
#   bash uninstall.sh --purge    also delete ~/.cempala/ (data included)
#   bash uninstall.sh --dry-run  print what would happen, change nothing

set -euo pipefail

purge=0
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --purge)   purge=1 ;;
    --dry-run) dry_run=1 ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "error: unknown option: $arg" >&2; exit 1 ;;
  esac
done

bin_dir="${HOME}/.cempala/bin"
bin="${bin_dir}/cempala"

# Set when a cleanup step fails. It changes two things at the end: the
# binary is KEPT (it is the only thing that can retry the step that
# failed), and the closing banner says the uninstall was partial instead
# of claiming success over the top of a warning.
cleanup_failed=0

say() { echo "$@"; }
run() {
  # In dry-run mode, show the command instead of running it. Everything
  # that CHANGES something goes through here, so --dry-run is a real
  # guarantee rather than a promise scattered across the script.
  if [ "$dry_run" = "1" ]; then
    echo "    would run: $*"
  else
    "$@"
  fi
}

echo "cempala uninstaller"
if [ "$dry_run" = "1" ]; then echo "  (dry run — nothing will be changed)"; fi
echo

# --- 1. Unregister from Claude Code and Codex -------------------------------
#
# Each CLI's own command, not a hand-edit of its config. Their file formats
# are theirs to change, and `mcp remove` is the one interface that is
# guaranteed to keep up with them.
#
# A missing CLI is not an error: plenty of people install cempala, use it
# with one agent, and never install the other.
unregister_cli() {
  local name="$1"; shift
  if ! command -v "$name" >/dev/null 2>&1; then
    say "  · $name not on PATH; nothing to unregister"
    return 0
  fi
  local rc=0 out=""
  if [ "$dry_run" = "1" ]; then
    echo "    would run: $name mcp remove cempala $*"
    return 0
  fi
  out=$("$name" mcp remove cempala "$@" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ]; then
    say "  ✓ unregistered from $name"
  else
    # Already gone is the common case and is not a failure worth shouting
    # about; anything else, the user needs to know and to see the command.
    if printf '%s' "$out" | grep -qi "no mcp server\|not found\|does not exist"; then
      say "  ✓ $name had no cempala registration"
    else
      # A GENUINE failure counts as a failed cleanup. Warning and carrying
      # on meant the binary was deleted anyway and the run ended with a
      # success banner, leaving a live registration pointing at nothing —
      # the precise outcome this whole script exists to prevent.
      cleanup_failed=1
      say "  ! could not unregister from $name — run it yourself:"
      say "      $name mcp remove cempala $*"
      [ -n "$out" ] && say "      $out"
    fi
  fi
}

echo "→ removing MCP registrations"
unregister_cli claude --scope user
unregister_cli codex

# --- 2. Unregister from Antigravity -----------------------------------------
#
# Antigravity ships no `mcp remove`, so the binary does it: one key removed
# from ~/.gemini/config/mcp_config.json, every other server and setting left
# exactly as it was, and the file never deleted — it is Antigravity's.
#
# This needs the binary, and it needs a binary NEW enough to know the flag.
# An older one does not reject an unknown flag; it starts the stdio MCP
# server and reads stdin, which is why the input is closed here just as it
# is in install.sh. If the flag is unsupported or the binary is already
# gone, say what to do by hand rather than pretend it was handled.
ag_config="${HOME}/.gemini/config/mcp_config.json"
if [ -x "$bin" ] && "$bin" --help </dev/null 2>/dev/null | grep -q -- "--unregister-antigravity"; then
  if [ "$dry_run" = "1" ]; then
    echo "    would run: $bin --unregister-antigravity"
  else
    if ! "$bin" --unregister-antigravity </dev/null; then
      cleanup_failed=1
      say "  ! antigravity unregistration failed; edit $ag_config by hand"
    fi
  fi
elif [ -f "$ag_config" ] && grep -q '"cempala"' "$ag_config" 2>/dev/null; then
  # A registration we could not remove is LIVE CONFIGURATION LEFT BEHIND,
  # not a note in passing. Printing instructions and carrying on let the
  # run finish with a success banner — and under --purge it would delete
  # the database while Antigravity still pointed at a binary that was
  # about to vanish.
  cleanup_failed=1
  say "  ! this cempala build cannot unregister itself from Antigravity."
  say "    Remove the \"cempala\" entry from \"mcpServers\" in:"
  say "      $ag_config"
else
  say "  ✓ cempala was not registered with Antigravity"
fi

# --- 3. Strip the PATH export from the shell startup files -------------------
#
# Every file install.sh has ever written to is offered, not just the ones
# it writes to today — someone uninstalling may have installed under an
# older version that picked a different file. Removal only ever touches a
# block still carrying the installer's marker comment, so a file that
# merely mentions the same path is left alone.
echo
echo "→ removing the PATH export"
rc_candidates=(
  "${HOME}/.zshrc" "${HOME}/.zprofile"
  "${HOME}/.bashrc" "${HOME}/.bash_profile" "${HOME}/.bash_login"
  "${HOME}/.profile"
)
#
# Only files that actually CONTAIN the marker are considered. Checking for
# the block first is what keeps the fallback warning honest: on a second
# run, or on a machine where the export was already removed by hand, there
# is nothing to strip, and telling someone to go and edit their shell
# config for a block that is not there is worse than saying nothing.
marker="# cempala installer — added by install.sh"
existing_rc=()
for f in "${rc_candidates[@]}"; do
  if [ -f "$f" ] && grep -qF "$marker" "$f" 2>/dev/null; then
    existing_rc+=("$f")
  fi
done

if [ "${#existing_rc[@]}" -eq 0 ]; then
  say "  ✓ no cempala PATH export found"
elif [ -x "$bin" ] && "$bin" --help </dev/null 2>/dev/null | grep -q -- "--remove-path-block"; then
  if [ "$dry_run" = "1" ]; then
    echo "    would run: $bin --remove-path-block ${existing_rc[*]}"
  else
    if ! "$bin" --remove-path-block "${existing_rc[@]}" </dev/null; then
      # KEEP THE BINARY. It is the only thing that can safely retry this,
      # and deleting it here would strand the user with a PATH block and
      # no tool able to remove it. Reporting a partial uninstall and
      # leaving the means to finish beats a tidy-looking failure.
      cleanup_failed=1
      say "  ! the PATH export could not be removed (see above)"
    fi
  fi
else
  # There IS a block, but no binary able to remove it — an old build, or
  # one already deleted. Deliberately NOT falling back to a hand-rolled
  # sed: the rules that keep this safe (marker required, line endings
  # preserved, a missing final newline preserved) are exactly the ones a
  # quick one-liner gets wrong, and getting them wrong corrupts a shell
  # config. Name the files and the line instead — and count it as a
  # failure, because a PATH export left in place is exactly the residue
  # this script exists to remove.
  cleanup_failed=1
  say "  ! this cempala build cannot strip the PATH export."
  say "    Delete this line and the block below it, in:"
  for f in "${existing_rc[@]}"; do say "      $f"; done
fi

# --- 4. The install directory ------------------------------------------------
echo
if [ "$purge" = "1" ] && [ "$cleanup_failed" = "1" ]; then
  # PURGE IS SKIPPED when a step failed, and this ordering is the point.
  # `--purge` deletes the binary along with everything else, so purging
  # after a failure would remove the one tool able to retry — and do it
  # while destroying the database, irreversibly, on a system left half
  # uninstalled. Refusing is recoverable; the alternative is not.
  echo "→ NOT purging: a step above failed"
  say "  · ${HOME}/.cempala was left alone, including your data"
  say "    Fix what is reported above, then re-run with --purge."
elif [ "$purge" = "1" ]; then
  echo "→ removing ~/.cempala (including the database and audit log)"
  run rm -rf "${HOME}/.cempala"
  [ "$dry_run" = "1" ] || say "  ✓ removed ${HOME}/.cempala"
elif [ "$cleanup_failed" = "1" ]; then
  # Something above could not be undone. Where a binary exists it is what
  # would undo it on a retry, so it stays. Where there ISN'T one — an old
  # build already removed, or never installed — say that instead of
  # claiming to have kept something that is not there.
  if [ -e "$bin" ]; then
    echo "→ keeping the binary: a cleanup step failed and you will need it to retry"
    say "  · left $bin in place"
  else
    echo "→ no binary to remove"
    say "  · a cleanup step failed; see above for what to finish by hand"
  fi
else
  echo "→ removing the binary, keeping your data"
  if [ -e "$bin" ]; then
    run rm -f "$bin"
    [ "$dry_run" = "1" ] || say "  ✓ removed $bin"
  else
    say "  · no binary at $bin"
  fi
  # Take the bin directory only if it is now empty; anything else in there
  # is not ours.
  if [ -d "$bin_dir" ] && [ -z "$(ls -A "$bin_dir" 2>/dev/null)" ]; then
    run rmdir "$bin_dir"
  fi
fi

echo
if [ "$dry_run" = "1" ]; then
  echo "✓ dry run complete — nothing was changed."
  exit 0
fi

if [ "$cleanup_failed" = "1" ]; then
  # Do not print a success banner over the top of a warning. A user who
  # scrolls to the last line has to see that this did not finish.
  echo "! cempala was PARTIALLY uninstalled."
  echo
  echo "One or more steps above could not be completed."
  if [ -e "$bin" ]; then
    echo "The binary was kept so you can retry:"
    echo "  $bin"
    echo "Fix what the message above reports, then re-run this script."
  else
    echo "There is no cempala binary able to finish the job on this machine,"
    echo "so the remaining steps have to be done by hand — see above for"
    echo "exactly which files and lines."
  fi
  exit 1
fi

echo "✓ cempala uninstalled."
echo
if [ "$purge" = "0" ] && [ -d "${HOME}/.cempala" ]; then
  echo "Your data was kept, including the task history and audit log:"
  echo "  ${HOME}/.cempala"
  echo "Delete it yourself, or re-run with --purge, to remove that too."
  echo
fi
echo "RESTART any Claude Code, Codex or Antigravity session that is still open."
echo "Until you do, each one keeps the server it already launched."
