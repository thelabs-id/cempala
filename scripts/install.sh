#!/usr/bin/env bash
# scripts/install.sh — cempala installer for macOS / Linux
#
# Per FR-18..FR-22. Non-interactive, idempotent, designed to be piped from
# `curl -fsSL https://raw.githubusercontent.com/thelabs-id/cempala/main/scripts/install.sh | bash`.
#
# Steps (per AGENTS.md §8):
#   1. uname -s / uname -m → map to one of the four Unix release assets.
#   2. Download via curl, verify against the published SHA-256 checksum.
#   3. mkdir -p ~/.cempala/bin, stage the binary there and rename it into
#      place, chmod +x.
#   4. export PATH in this shell AND write it to the startup file(s) the
#      user's shell actually reads — which for bash is two files, see §4 —
#      so future shells pick it up.
#   5. Run `cempala --init` to write the default config if absent.
#   6. Detect claude / codex on PATH, run matching mcp add for each found;
#      print the manual command for each not found.

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
cleanup() {
  rm -rf "$tmpdir"
  if [ -n "$staged" ]; then rm -f "$staged"; fi
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

# The marker doubles as the idempotency check, so the snippet below can change
# without a re-run duplicating what an older installer already wrote.
rc_marker='# cempala installer — added by install.sh'

# What earlier versions of this installer wrote. Re-running has to replace it,
# not step over it: the marker is the same, so a plain "already present" check
# would leave every existing user on the old unguarded line forever, and no
# later fix to the snippet would ever reach them.
# shellcheck disable=SC2016  # a literal, matched byte-for-byte — never expanded
rc_legacy='export PATH="$HOME/.cempala/bin:$PATH"'

# strip_legacy <file> — remove what an earlier installer wrote, if present.
#
# Exit status: 0 migrated, 1 nothing to migrate, 2 legacy present but the
# migration could not be completed safely. The caller has to tell 2 from 1:
# both leave the file unmodified, but only 2 means the user is still on the
# old line and should hear about it.
strip_legacy() {
  local file="$1"
  # -x, so detection uses the same whole-line equality the removal below does.
  # A substring match would fire on a line that merely CONTAINS the old export
  # — someone's commented-out `# export PATH="$HOME/.cempala/bin:$PATH"` — and
  # then awk, matching whole lines, would find nothing to remove but the marker
  # of the current block. That leaves the block orphaned and appends a fresh
  # one, and it does it again on every re-run.
  grep -qFx "$rc_legacy" "$file" || return 1

  # Every failure branch below returns 1 and leaves the file untouched. This
  # function runs inside an `if`, which disables `set -e` for everything it
  # calls, so each step is checked by hand — an unnoticed failure here would
  # mean rewriting a shell config from a half-built temp file.
  local tmp
  tmp=$(mktemp "${file}.cempala.XXXXXX") || return 2

  # Exact whole-line equality, never a substring or pattern: the only lines
  # that may be deleted are ones byte-identical to what this installer itself
  # wrote. Anything a human typed — even something that merely looks similar —
  # is left alone.
  if ! awk -v marker="$rc_marker" -v legacy="$rc_legacy" '
    $0 == marker { next }
    $0 == legacy { next }
    { print }
  ' "$file" > "$tmp"; then
    rm -f "$tmp"
    return 2
  fi

  # Verify that exactly the intended lines went, and nothing else. Counting
  # them rather than assuming a fixed number matters: a file that accumulated
  # the block twice — two upgrades through different installer versions —
  # legitimately loses four lines, and a fixed "no more than three" guard
  # would refuse to migrate it and silently leave BOTH old exports in place.
  #
  # awk does the counting on both sides, not `wc -l`, so a file whose last
  # line has no trailing newline is counted the same way in both.
  local before removed after
  before=$(awk 'END { print NR + 0 }' "$file")
  removed=$(awk -v marker="$rc_marker" -v legacy="$rc_legacy" \
    '$0 == marker || $0 == legacy { n++ } END { print n + 0 }' "$file")
  after=$(awk 'END { print NR + 0 }' "$tmp")
  if [ "$after" -ne "$(( before - removed ))" ]; then
    rm -f "$tmp"
    return 2
  fi

  # Copy the contents back rather than renaming over the original. An rc file
  # is very often a symlink into a dotfiles repo, and a rename would silently
  # replace that link with a regular file — detaching it from the repo the
  # user manages it in. Writing through the link updates the tracked file,
  # which is what someone with that setup expects.
  #
  # The backup exists for the window between truncating $file and finishing
  # the write. It is a few bytes and one syscall against the possibility of
  # leaving a user with no working shell config at all.
  #
  # It comes from mktemp rather than a fixed "$file.cempala-backup" name. A
  # predictable name is one the user might already have — and we would then
  # overwrite their file and delete it on the way out. Worse, if that name
  # happened to be a symlink, the write would land on whatever it pointed at.
  # mktemp creates a fresh regular file that is unambiguously ours to remove.
  local backup
  backup=$(mktemp "${file}.cempala-bak.XXXXXX") || { rm -f "$tmp"; return 2; }
  if ! cp "$file" "$backup"; then
    rm -f "$tmp" "$backup"
    return 2
  fi
  if ! cat "$tmp" > "$file"; then
    cat "$backup" > "$file" || true
    rm -f "$tmp" "$backup"
    return 2
  fi
  rm -f "$tmp" "$backup"
  return 0
}

# append_rc <file> — add the PATH snippet unless this installer already did.
append_rc() {
  local file="$1"
  local created=""
  if [ ! -f "$file" ]; then
    : > "$file"
    created=1
  fi

  local migrated="" migrate_rc=0
  strip_legacy "$file" || migrate_rc=$?
  if [ "$migrate_rc" -eq 0 ]; then
    migrated=1
  elif [ "$migrate_rc" -eq 2 ]; then
    # The old line is still there and still works — it only misbehaves when
    # PATH is empty. Appending a second block on top of it would be worse than
    # saying so and leaving it alone.
    echo "  ! could not rewrite the PATH export in $file; left it untouched"
    echo "    (it still works; re-run this installer once the file is writable)"
    return 0
  fi

  if [ -z "$migrated" ] && grep -qF "$rc_marker" "$file"; then
    echo "→ PATH export already present in $file"
    return 0
  fi
  # Single quotes are the point, not an oversight: $HOME and $PATH have to
  # reach the file UNEXPANDED, so the line survives the account being moved
  # and doesn't freeze today's PATH into every future shell.
  #
  # The guard around the prepend matters because bash gets two files below and
  # a ~/.bash_profile that sources ~/.bashrc — a very common arrangement —
  # would otherwise stack the same directory onto PATH twice per login.
  #
  # ${PATH:+:$PATH} for the same reason as above: an empty PATH would leave a
  # trailing colon, and an empty PATH component means the current directory.
  # shellcheck disable=SC2016
  {
    echo ""
    echo "$rc_marker"
    echo 'case ":$PATH:" in'
    echo '  *":$HOME/.cempala/bin:"*) ;;'
    echo '  *) PATH="$HOME/.cempala/bin${PATH:+:$PATH}"; export PATH ;;'
    echo 'esac'
  } >> "$file"
  if [ -n "$created" ]; then
    echo "→ created $file with the PATH export"
  elif [ -n "$migrated" ]; then
    echo "→ replaced the PATH export an earlier installer left in $file"
  else
    echo "→ appended PATH export to $file"
  fi
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
  append_rc "$rc_file"
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

cat <<'EOF'

✓ cempala installed.

Next steps:
  - RESTART any Claude Code or Codex session that is already open, so it picks
    up the registration. Until you do, it will show cempala as failed.
  - Then run `<cli> mcp list` to confirm cempala is connected.
  - From any project under your home directory, dispatch or message the other agent.
  - For paths outside your home, call `approve_path` after the human confirms.

  (cempala is on your PATH for new shells too, but the MCP registration points
   at the binary directly, so it does not depend on that.)

To re-run this installer (e.g. to upgrade), it's safe — the binary is
overwritten in place and the MCP registrations are idempotent.
EOF
