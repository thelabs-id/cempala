#!/usr/bin/env bash
# scripts/install.sh — cempala installer for macOS / Linux
#
# Per FR-18..FR-22. Non-interactive, idempotent, designed to be piped from
# `curl -fsSL https://raw.githubusercontent.com/thelabs-id/cempala/main/scripts/install.sh | bash`.
#
# Steps:
#   1. uname -s / uname -m → map to one of the four Unix release assets.
#   2. Download via curl, verify against the published SHA-256 checksum.
#   3. mkdir -p ~/.cempala/bin, stage the binary there and rename it into
#      place, chmod +x.
#   4. export PATH in this shell AND write it to the startup file(s) the
#      user's shell actually reads — which for bash is two files, see §4 —
#      so future shells pick it up.
#   5. Run `cempala --init` to write the default config if absent.
#   6. Detect claude / codex / opencode on PATH, run matching mcp add for
#      each found; print the manual command for each not found. Antigravity
#      has no `mcp add`, so `cempala --register-antigravity` merges the entry
#      into ~/.gemini/config/mcp_config.json instead.

set -euo pipefail

# --- 1. Detect OS / arch ---
uname_s=$(uname -s)
uname_m=$(uname -m)

case "$uname_s" in
  Darwin) base="darwin" ;;
  Linux)  base="linux"  ;;
  *) echo "error: unsupported OS: $uname_s (cempala ships for darwin and linux only)" >&2; exit 1 ;;
esac

case "$uname_m" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64"   ;;
  *) echo "error: unsupported architecture: $uname_m" >&2; exit 1 ;;
esac

asset="cempala-${base}-${arch}"
echo "→ detected platform: ${base}-${arch}"

# --- 2. Locate the GitHub release tag ---
# Allow override via env; default to 'latest'.
: "${CEMPALA_VERSION:=latest}"
repo="thelabs-id/cempala"
if [ "$CEMPALA_VERSION" = "latest" ]; then
  release_url="https://github.com/${repo}/releases/latest/download"
else
  release_url="https://github.com/${repo}/releases/download/${CEMPALA_VERSION}"
fi

tmpdir=$(mktemp -d)
staged=""
# Scratch files created while rewriting a shell rc file. They live beside the
# rc file itself (so a rename stays on one filesystem, and so a symlinked rc
# file is written through rather than replaced), which means they are NOT under
# $tmpdir and need tracking of their own. Without this, a Ctrl-C at the wrong
# moment leaves .zshrc.cempala.XXXXXX sitting in the user's home directory.
rc_scratch=""
cleanup() {
  rm -rf "$tmpdir"
  if [ -n "$staged" ]; then rm -f "$staged"; fi
  if [ -n "$rc_scratch" ]; then
    # Deliberately unquoted: this is a newline-separated list, not one path.
    # Home directories with spaces are handled by the IFS below.
    local IFS='
'
    for f in $rc_scratch; do rm -f "$f"; done
  fi
}
trap cleanup EXIT

echo "→ downloading ${asset} (${CEMPALA_VERSION})"
curl -fsSL "${release_url}/${asset}" -o "${tmpdir}/${asset}"
curl -fsSL "${release_url}/checksums.txt" -o "${tmpdir}/checksums.txt"

# Verify the binary against checksums.txt BEFORE doing anything with it.
echo "→ verifying sha-256"
#
# `|| true` is load-bearing. Under `set -e` with `pipefail`, a grep that
# matches nothing fails the pipeline, which fails the assignment, which exits
# the script on the spot — so the explanatory message below could never print
# and a release cut without a checksum line looked like a silent crash.
#
# The pattern allows the optional `*` binary-mode marker that some sha-256
# tools emit, and accepts either hex case. Both details exist to match
# install.ps1, whose -match and -ne are case-insensitive: a checksums.txt with
# uppercase digests must not be readable by one installer and rejected by the
# other.
expected=$(grep -Ei "^[a-f0-9]+[[:space:]]+\*?${asset}\$" "${tmpdir}/checksums.txt" | awk '{print $1}') || true
if [ -z "$expected" ]; then
  echo "error: no checksum found for ${asset} in checksums.txt" >&2
  exit 1
fi

# Pick a sha-256 tool that exists on this OS. macOS doesn't ship
# `sha256sum`; fall back to `shasum -a 256` there. `openssl dgst -sha256`
# is the universal fallback.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo "error: no sha-256 tool found (need sha256sum, shasum, or openssl)" >&2
    exit 1
  fi
}

actual=$(sha256_of "${tmpdir}/${asset}")
# Compare case-insensitively for the same reason the grep above is: the digest
# in checksums.txt may legitimately be uppercase.
expected=$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')
actual=$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')
if [ "$expected" != "$actual" ]; then
  echo "error: sha-256 mismatch for ${asset}" >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual"   >&2
  exit 1
fi
echo "  ✓ checksum verified"

# --- 3. Install to ~/.cempala/bin ---
bin_dir="${HOME}/.cempala/bin"
mkdir -p "$bin_dir"

# Stage inside the destination directory, then rename into place. Two distinct
# reasons this is not a plain `mv` from the temp dir:
#
#   - `mktemp -d` regularly lands on a different filesystem than $HOME (a tmpfs
#     /tmp is the norm on Linux), and a cross-device mv is really a copy — it
#     opens the destination for writing, which fails with ETXTBSY when the
#     destination is an executable someone is running.
#   - The destination usually IS running. Upgrading while an agent holds
#     cempala open as an MCP server is the ordinary case, not the exception,
#     and FR-22 says re-running the installer has to be safe.
#
# A rename within one directory is atomic and merely unlinks the old inode:
# the running server keeps using the file it already opened until it exits,
# and every new launch gets the new binary. Nobody's session has to be killed
# to upgrade. This is the Unix counterpart of the rename-aside dance
# install.ps1 does for Windows' file locks.
#
# Sweep anything a previous run left behind after being killed between the
# copy and the rename — the EXIT trap covers every ordinary failure, but not
# SIGKILL or a closed terminal. Only files older than an hour are touched: a
# blanket `rm .cempala.new.*` would delete the staging file of a second
# installer running right now and break it at chmod or mv.
find "$bin_dir" -maxdepth 1 -name '.cempala.new.*' -mmin +60 -exec rm -f {} + 2>/dev/null || true

# `mktemp` rather than a $$-derived name: it creates the file atomically and
# cannot collide, whereas PIDs do repeat across containers sharing a home
# directory — which would let two runs stage on top of each other, and let one
# run's EXIT trap delete the other's staged binary.
staged=$(mktemp "${bin_dir}/.cempala.new.XXXXXX")
cp "${tmpdir}/${asset}" "$staged"
chmod +x "$staged"
mv -f "$staged" "${bin_dir}/cempala"
staged=""
echo "→ installed to ${bin_dir}/cempala"

# --- 4. PATH for this shell AND future shells ---
#
# ${PATH:+:${PATH}} rather than a plain "${bin_dir}:${PATH}": if PATH is empty,
# the latter leaves a trailing colon, and an empty component in PATH means the
# CURRENT DIRECTORY. Silently putting `.` on PATH is not a formatting nit —
# it means a stray executable in whatever directory you happen to be standing
# in can shadow a real command.
export PATH="${bin_dir}${PATH:+:${PATH}}"

# Write to the file(s) the shell the user actually runs will actually read.
#
# "First of zshrc/bashrc/profile that exists" is wrong twice over. It lands the
# export in a stray ~/.zshrc some other tool left behind, which a bash user's
# shell never sources; and for bash it picks the wrong file even when the shell
# is right, because bash reads a DIFFERENT startup file depending on how it was
# started, and which way that goes depends on the platform. Either way the
# installer reports success while cempala stays absent from PATH.
shell_name=$(basename "${SHELL:-}")

# --- what this installer writes, and every form it has ever written ---------
#
# Removal is driven off these lists, and so is detection: "is a block already
# here" is answered by running the removal and seeing whether it changed
# anything, never by a separate grep. That is deliberate. Two rounds of bugs in
# this file came from a detection rule drifting from the removal rule — a
# substring check firing on a commented-out copy, a marker check that deleted
# the marker of a block it should have kept. One rule cannot disagree with
# itself.
rc_marker='# cempala installer — added by install.sh'

# The block written today. Guarded, so being sourced twice — or from both of
# bash's two startup files — cannot stack the directory onto PATH twice, and
# ${PATH:+:$PATH} so an empty PATH does not gain a trailing colon (an empty
# PATH component means the current directory).
#
# Single-quoted throughout: $HOME and $PATH must reach the file UNEXPANDED.
# shellcheck disable=SC2016
rc_body_current=(
  'case ":$PATH:" in'
  '  *":$HOME/.cempala/bin:"*) ;;'
  '  *) PATH="$HOME/.cempala/bin${PATH:+:$PATH}"; export PATH ;;'
  'esac'
)

# What older versions wrote. Kept so an upgrade REPLACES it rather than leaving
# the user on a snippet no later fix can reach.
# shellcheck disable=SC2016
rc_body_legacy=(
  'export PATH="$HOME/.cempala/bin:$PATH"'
)

# rc_track <path>... — remember a scratch file so the EXIT trap removes it if
# this run is interrupted. Each function still deletes its own files on the
# normal path; this is the backstop for the paths that never get there.
rc_track() {
  while [ "$#" -gt 0 ]; do
    rc_scratch="${rc_scratch}${rc_scratch:+
}$1"
    shift
  done
}

# rc_filter <src> <dst> <dropfile> — copy src to dst without any cempala block.
#
# Removes, by exact whole-line equality only:
#   - the marker line together with the known body directly beneath it,
#   - one blank line immediately above such a block, so repeated upgrades do
#     not accumulate blank lines.
# Nothing else. A marker followed by something unrecognised is LEFT ALONE, and
# so is a body with no marker above it — both are someone's own edit, and
# guessing at them is how you destroy a shell config.
#
# Writes the number of dropped lines to <dropfile>. Returns non-zero if awk
# failed or the line counts do not add up.
rc_filter() {
  local src="$1" dst="$2" dropfile="$3"
  local cur leg before after dropped no_final_nl
  cur=$(printf '%s\n' "${rc_body_current[@]}")
  leg=$(printf '%s\n' "${rc_body_legacy[@]}")

  # Does the source end without a newline? awk cannot tell, and its `print`
  # would add one, so the answer has to come from outside and be passed in.
  no_final_nl=""
  if [ -s "$src" ] && [ "$(tail -c 1 "$src" | od -An -c | tr -d ' \n')" != "\\n" ]; then
    no_final_nl=1
  fi

  # The bodies travel through the ENVIRONMENT, not `awk -v`. A -v assignment
  # cannot carry a literal newline — BSD awk fails outright with "newline in
  # string" — and it also processes backslash escapes, neither of which is what
  # a multi-line block of shell code needs. Prefixed assignments like these
  # apply to this one command and do not leak into the rest of the script.
  CEMPALA_RC_MARKER="$rc_marker" CEMPALA_RC_CUR="$cur" CEMPALA_RC_LEG="$leg" \
  awk -v dropfile="$dropfile" -v no_final_nl="$no_final_nl" '
    # bare() drops a trailing CR so a file that has been through a Windows
    # editor still matches. Comparison only — what gets printed is always the
    # original bytes, so line endings elsewhere in the file are left as they
    # were found.
    function bare(s) { sub(/\r$/, "", s); return s }
    function matches(start, arr, n,   k) {
      for (k = 1; k <= n; k++)
        if (bare(line[start + k - 1]) != arr[k]) return 0
      return 1
    }
    BEGIN {
      marker = ENVIRON["CEMPALA_RC_MARKER"]
      nc = split(ENVIRON["CEMPALA_RC_CUR"], C, "\n")
      nl = split(ENVIRON["CEMPALA_RC_LEG"], L, "\n")
    }
    { line[NR] = $0 }
    END {
      no = 0; n = 0
      for (i = 1; i <= NR; i++) {
        # A body is only ever removed together with the marker line above it.
        #
        # Matching a body on its own is not safe, however tempting it is as a
        # way to tidy up after a hand edit. These are ordinary lines of shell,
        # and identical text can legitimately appear inside a heredoc, a quoted
        # string, or simply because someone wrote the same export themselves —
        # deleting it would corrupt a file this installer does not own. The
        # marker is a comment only this installer writes, and requiring it is
        # what makes a match evidence rather than a guess.
        #
        # The cost is that a block orphaned from its marker stays. That is
        # cosmetic: the block is guarded, so it sets PATH at most once and the
        # current block added below is a no-op next to it.
        drop = 0
        if (bare(line[i]) == marker) {
          if (matches(i + 1, C, nc))      drop = 1 + nc
          else if (matches(i + 1, L, nl)) drop = 1 + nl
        }
        if (drop) {
          if (no > 0 && bare(out[no]) == "") { no--; n++ }
          n += drop
          i += drop - 1
          continue
        }
        out[++no] = line[i]
        srcidx[no] = i
      }
      for (k = 1; k <= no; k++) {
        # Reproduce the absence of a final newline rather than quietly adding
        # one. Rewriting a file to remove our block should change our block and
        # nothing else, down to the last byte.
        #
        # It applies only when the line that ends the OUTPUT is the same line
        # that ended the INPUT. If the unterminated last line was itself part
        # of a block we just removed, the line now at the end is a different
        # one that did end in a newline, and stripping its newline would be a
        # change to a line we were never asked to touch.
        if (k == no && no_final_nl && srcidx[no] == NR) printf "%s", out[k]
        else print out[k]
      }
      print n > dropfile
    }
  ' "$src" > "$dst" || return 1

  before=$(awk 'END { print NR + 0 }' "$src")
  after=$(awk 'END { print NR + 0 }' "$dst")
  dropped=$(cat "$dropfile" 2>/dev/null || echo 0)
  # The count comes from the same pass that produced the output, so this is a
  # check on the write actually landing, not a second opinion about the rule.
  [ "$after" -eq "$(( before - dropped ))" ] || return 1
}

# rc_write_back <file> <new-contents> — replace file's contents in place.
#
# Copies rather than renames: an rc file is very often a symlink into a
# dotfiles repo, and a rename would silently replace that link with a regular
# file, detaching it from the repo the user manages it in. The backup covers
# the window between truncating and finishing the write, and comes from mktemp
# because a predictable name is one the user might already be using.
#
# That choice is a real trade: copying is not atomic the way a rename is, so an
# edit made in the seconds between filtering and writing back would be lost,
# and there is no lock preventing two installers from racing each other. Both
# are accepted deliberately. Preserving a dotfiles symlink matters to people
# every time they upgrade; the race needs someone to be editing their shell
# config, or running two installers, during a window a few milliseconds wide.
# A lock file would also have to survive being abandoned by a killed installer,
# which is its own way to leave a user stuck.
rc_write_back() {
  local file="$1" new="$2" backup
  backup=$(mktemp "${file}.cempala-bak.XXXXXX") || return 1
  rc_track "$backup"
  if ! cp "$file" "$backup"; then
    rm -f "$backup"
    return 1
  fi
  if ! cat "$new" > "$file"; then
    cat "$backup" > "$file" || true
    rm -f "$backup"
    return 1
  fi
  rm -f "$backup"
}

# ensure_rc <file> — leave <file> holding exactly the current block.
ensure_rc() {
  local file="$1"
  local created=""
  if [ ! -f "$file" ]; then
    : > "$file"
    created=1
  fi

  local tmp dropfile
  tmp=$(mktemp "${file}.cempala.XXXXXX") || { rc_warn "$file"; return 0; }
  dropfile="${tmp}.dropped"
  rc_track "$tmp" "$dropfile"

  if ! rc_filter "$file" "$tmp" "$dropfile"; then
    rm -f "$tmp" "$dropfile"
    rc_warn "$file"
    return 0
  fi
  local dropped
  dropped=$(cat "$dropfile" 2>/dev/null || echo 0)
  rm -f "$dropfile"

  {
    echo ""
    echo "$rc_marker"
    printf '%s\n' "${rc_body_current[@]}"
  } >> "$tmp"

  # Strip-then-append and compare, rather than asking up front whether a block
  # is present. A file already holding the current block rebuilds to something
  # byte-identical, so it is left completely untouched — and there is no
  # separate "is it there?" rule that could disagree with the removal.
  if cmp -s "$file" "$tmp"; then
    echo "→ PATH export already present in $file"
    rm -f "$tmp"
    return 0
  fi

  if ! rc_write_back "$file" "$tmp"; then
    rm -f "$tmp"
    rc_warn "$file"
    return 0
  fi
  rm -f "$tmp"

  if [ -n "$created" ]; then
    echo "→ created $file with the PATH export"
  elif [ "$dropped" -gt 0 ]; then
    echo "→ replaced the PATH export an earlier installer left in $file"
  else
    echo "→ appended PATH export to $file"
  fi
}

rc_warn() {
  echo "  ! could not update the PATH export in $1; left it untouched"
  echo "    (re-run this installer once that file is writable)"
}

# purge_rc <file> — remove any cempala block from a file we no longer write to.
#
# Older versions picked the first rc file that happened to EXIST, which for a
# bash user was frequently a stray ~/.zshrc their shell never reads. Upgrading
# writes to the right files, but without this the old block sits there forever,
# pointing at an install that may since have moved.
purge_rc() {
  local file="$1"
  [ -f "$file" ] || return 0

  local tmp dropfile dropped
  tmp=$(mktemp "${file}.cempala.XXXXXX") || return 0
  dropfile="${tmp}.dropped"
  rc_track "$tmp" "$dropfile"
  if ! rc_filter "$file" "$tmp" "$dropfile"; then
    rm -f "$tmp" "$dropfile"
    return 0
  fi
  dropped=$(cat "$dropfile" 2>/dev/null || echo 0)
  rm -f "$dropfile"

  if [ "$dropped" -eq 0 ]; then
    rm -f "$tmp"
    return 0
  fi
  if rc_write_back "$file" "$tmp"; then
    echo "→ removed a stale cempala PATH export from $file"
    echo "  (an older installer put it there; the current one is in ${rc_targets[0]})"
  fi
  rm -f "$tmp"
}

case "$shell_name" in
  zsh)
    # Interactive zsh sources ~/.zshrc whether or not it is a login shell, so
    # this single file covers every way the user can open a terminal.
    rc_targets=( "${HOME}/.zshrc" )
    ;;
  bash)
    # Bash does not have zsh's one-file-covers-everything property. A LOGIN
    # shell reads ~/.bash_profile (falling back to ~/.bash_login, then
    # ~/.profile) and ignores ~/.bashrc; a non-login interactive shell does the
    # exact opposite. macOS terminals open login shells, Linux desktop
    # terminals open non-login ones, and ssh gives you the login path on both —
    # so there is no single correct file, and choosing one means being wrong
    # for a large fraction of users. Write one of each. The guarded prepend
    # above is what makes that safe when both end up being read.
    login_rc=""
    for candidate in "${HOME}/.bash_profile" "${HOME}/.bash_login" "${HOME}/.profile"; do
      if [ -f "$candidate" ]; then
        login_rc="$candidate"
        break
      fi
    done
    # None exist yet: bash consults ~/.bash_profile first, so create that one.
    [ -n "$login_rc" ] || login_rc="${HOME}/.bash_profile"
    rc_targets=( "$login_rc" "${HOME}/.bashrc" )
    ;;
  *)
    rc_targets=( "${HOME}/.profile" )
    ;;
esac

for rc_file in "${rc_targets[@]}"; do
  ensure_rc "$rc_file"
done

# Then sweep every other startup file this installer might once have written
# to. An older version picked the first rc file that happened to EXIST, so an
# upgrade can leave a block behind in a file we no longer write to — pointing
# at an install that may since have moved. Removing it is the whole point of
# re-running an installer: one current copy, in the right place, and nothing
# stale left over.
for candidate in \
  "${HOME}/.zshrc" "${HOME}/.zprofile" \
  "${HOME}/.bashrc" "${HOME}/.bash_profile" "${HOME}/.bash_login" \
  "${HOME}/.profile"
do
  is_target=""
  for rc_file in "${rc_targets[@]}"; do
    if [ "$candidate" = "$rc_file" ]; then
      is_target=1
      break
    fi
  done
  [ -n "$is_target" ] || purge_rc "$candidate"
done

case "$shell_name" in
  zsh|bash) ;;
  *)
    echo "  ! your login shell (${shell_name:-unknown}) may not read ${rc_targets[0]}; if"
    echo "    cempala isn't found in a new shell, add its bin dir to PATH the way"
    echo "    that shell expects: ${bin_dir}"
    ;;
esac

# --- 5. cempala --init ---
echo "→ running cempala --init"
"${bin_dir}/cempala" --init

# --- 6. Auto-register with claude / codex where present ---
# register <cli> <binary-path> [extra add/remove flags...]
#
# Flags are passed as real arguments rather than a single word-split string,
# because the binary path is now absolute and a user whose home contains a
# space would otherwise have it split into two arguments.
#
# They stay in "$@" instead of being copied into a `flags` array, and that is
# not a style preference. macOS still ships bash 3.2, where expanding an EMPTY
# array as "${arr[@]}" under `set -u` is an "unbound variable" error rather
# than nothing at all. `register codex "$bin"` passes no flags, so the array
# was empty and the installer died there — after claude was registered, before
# codex was, and before the closing instructions ever printed. "$@" is exempt
# from that rule in every bash and expands to nothing when there is nothing to
# expand. The arrays built from it below always have elements, so they are
# safe to expand normally.
register() {
  local name="$1"; shift
  local bin="$1"; shift
  local add_args=( mcp add cempala "$@" -- "$bin" )
  local remove_args=( mcp remove cempala "$@" )

  # Copy-pasteable form of the add command for the messages below. The path is
  # absolute and may contain spaces, so it is quoted; the flags are joined
  # only when there are some, so no stray double space appears without them.
  local hint="$name mcp add cempala"
  if [ "$#" -gt 0 ]; then hint="$hint $*"; fi
  hint="$hint -- \"$bin\""

  if ! command -v "$name" >/dev/null 2>&1; then
    echo "  ! $name not found on PATH. To register cempala manually once $name is installed, run:"
    echo "      $hint"
    return 0
  fi

  echo "→ $name found, registering cempala as an MCP server"
  local rc=0 out=""
  out=$("$name" "${add_args[@]}" 2>&1) || rc=$?
  [ -n "$out" ] && echo "$out"
  if [ "$rc" -eq 0 ]; then
    echo "  ✓ $name mcp add succeeded"
    return 0
  fi

  # FR-22: re-running the installer must be safe. Not every CLI's `mcp add`
  # is idempotent — `codex mcp add` updates in place and exits 0, but
  # `claude mcp add` exits 1 with "already exists" and offers no
  # --force/--update flag. So for THAT failure specifically, drop the
  # existing registration and add it again. That also picks up a changed
  # command line on upgrade, which "already exists, skipping" would not.
  #
  # The match on the CLI's message is deliberately narrow. Reacting to any
  # non-zero exit would mean a transient failure (a locked config, a
  # permissions problem) causes us to DELETE a perfectly good registration
  # and then possibly fail to re-add it — turning a working install into a
  # broken one. Leaving an existing registration untouched is always the safe
  # direction when we cannot identify the failure.
  if printf '%s' "$out" | grep -qi "already exists"; then
    "$name" "${remove_args[@]}" >/dev/null 2>&1 || true
    rc=0
    "$name" "${add_args[@]}" || rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "  ✓ $name mcp add succeeded (re-registered)"
      return 0
    fi
  fi

  echo "  ! $name mcp add failed (rc=$rc) — you may need to re-run it manually:"
  echo "      $hint"
  return 0
}

# Register the ABSOLUTE path, not the bare name `cempala`.
#
# A bare name makes the agent CLI resolve it through PATH at launch, and a
# process gets a COPY of the environment when it starts. Install cempala while
# an agent CLI is already running and that process's PATH predates the bin
# directory, so it cannot find the executable and reports the server as failed
# — with a working binary on disk and a correct registration. Nothing is wrong
# except where the client is looking. We know where the binary was just put, so
# there is no reason to make the client rediscover it.
register claude "${bin_dir}/cempala" --scope user
register codex  "${bin_dir}/cempala"

# OpenCode takes the same shape: `opencode mcp add cempala -- <bin>` is
# non-interactive, exits 0, and updates an existing entry in place rather
# than refusing — so the "already exists" retry above never fires for it.
#
# It writes to `~/.config/opencode/opencode.jsonc` (or an `opencode.json`
# already there), preserving that file's comments and other servers, which
# is exactly why the CLI does this rather than us: OpenCode's config is
# JSONC and the CLI is the thing that knows how to edit it without
# flattening it. Removal is the half OpenCode has no command for, and the
# uninstaller handles that with `cempala --unregister-opencode`.
register opencode "${bin_dir}/cempala"

# Antigravity has no `mcp add` subcommand — `agy --help` lists agent,
# changelog, help, install, models, plugin and update, and the docs say to
# edit `~/.gemini/config/mcp_config.json` directly. So the registration is a
# JSON merge, and cempala does it itself rather than this script growing a
# dependency on jq or python3 (and install.ps1 growing a second copy of the
# same rule). It preserves any servers already in that file, and refuses to
# touch a config it cannot parse.
#
# Registered unconditionally, not only when `agy` is on PATH: the same file
# is read by the Antigravity IDE, which people install without ever putting
# the CLI on PATH. The only cost of writing it for someone who has neither
# is one unused entry in a file Antigravity would have created anyway.
#
# `</dev/null` is load-bearing. A cempala older than this flag does not
# reject it — it falls through to starting the stdio MCP server and reads
# stdin. That is reachable in two ordinary ways: installing while the
# newest release predates the flag, and `CEMPALA_VERSION=v0.1.0` pinning an
# old build on purpose, which this script explicitly supports. With a
# terminal on stdin the server would sit there waiting forever; under
# `curl | bash` the child inherits the pipe bash is still reading the script
# from. An immediate EOF makes such a binary exit at once instead.
echo "→ registering cempala with Antigravity"
"${bin_dir}/cempala" --register-antigravity "${bin_dir}/cempala" </dev/null || \
  echo "  ! antigravity registration step failed; cempala is otherwise installed"

cat <<'EOF'

✓ cempala installed.

Next steps:
  - RESTART any Claude Code, Codex, Antigravity or OpenCode session that is
    already open, so it picks up the registration. Until you do, it will show
    cempala as failed.
  - Then run `<cli> mcp list` to confirm cempala is connected (in Antigravity,
    type `/mcp` in the prompt, or check Settings → Installed MCP Servers).
  - From any project under your home directory, dispatch or message the other agent.
  - For paths outside your home, call `approve_path` after the human confirms.

  (cempala is on your PATH for new shells too, but the MCP registration points
   at the binary directly, so it does not depend on that.)

To re-run this installer (e.g. to upgrade), it's safe — the binary is
overwritten in place and the MCP registrations are idempotent.
EOF
