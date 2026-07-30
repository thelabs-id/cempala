#!/usr/bin/env bash
# scripts/install.sh — cempala installer for macOS / Linux
#
# Per FR-18..FR-22. Non-interactive, idempotent, designed to be piped from
# `curl -fsSL https://raw.githubusercontent.com/thelabs-id/cempala/main/scripts/install.sh | bash`.
#
# Steps (per AGENTS.md §8):
#   1. uname -s / uname -m → map to one of the four Unix release assets.
#   2. Download via curl, verify against the published SHA-256 checksum.
#   3. mkdir -p ~/.cempala/bin, move the binary there, chmod +x.
#   4. export PATH in this shell AND append to whichever rc file exists
#      (zshrc, bashrc, profile — in that order, first match wins) so
#      future shells pick it up.
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
trap 'rm -rf "$tmpdir"' EXIT

echo "→ downloading ${asset} (${CEMPALA_VERSION})"
curl -fsSL "${release_url}/${asset}" -o "${tmpdir}/${asset}"
curl -fsSL "${release_url}/checksums.txt" -o "${tmpdir}/checksums.txt"

# Verify the binary against checksums.txt BEFORE doing anything with it.
echo "→ verifying sha-256"
expected=$(grep -E "  ${asset}\$" "${tmpdir}/checksums.txt" | awk '{print $1}')
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
mv "${tmpdir}/${asset}" "${bin_dir}/cempala"
chmod +x "${bin_dir}/cempala"
echo "→ installed to ${bin_dir}/cempala"

# --- 4. PATH for this shell AND future shells ---
export PATH="${bin_dir}:${PATH}"

# Pick the first rc file that already exists; don't create one.
rc_file=""
for candidate in "${HOME}/.zshrc" "${HOME}/.bashrc" "${HOME}/.profile"; do
  if [ -f "$candidate" ]; then
    rc_file="$candidate"
    break
  fi
done

if [ -n "$rc_file" ]; then
  # Append only if the export line isn't already there.
  if ! grep -qF 'export PATH="$HOME/.cempala/bin:$PATH"' "$rc_file"; then
    echo "" >> "$rc_file"
    echo '# cempala installer — added by install.sh' >> "$rc_file"
    echo 'export PATH="$HOME/.cempala/bin:$PATH"' >> "$rc_file"
    echo "→ appended PATH export to $rc_file"
  else
    echo "→ PATH export already present in $rc_file"
  fi
else
  echo "  ! no shell rc file found (zshrc/bashrc/profile); start a new shell and"
  echo "    add this to your rc manually: export PATH=\"\$HOME/.cempala/bin:\$PATH\""
fi

# --- 5. cempala --init ---
echo "→ running cempala --init"
"${bin_dir}/cempala" --init

# --- 6. Auto-register with claude / codex where present ---
# register <cli> <binary-path> [extra add/remove flags...]
#
# Flags are passed as real arguments rather than a single word-split string,
# because the binary path is now absolute and a user whose home contains a
# space would otherwise have it split into two arguments.
register() {
  local name="$1"; shift
  local bin="$1"; shift
  local flags=( "$@" )
  local add_args=( mcp add cempala "${flags[@]}" -- "$bin" )
  local remove_args=( mcp remove cempala "${flags[@]}" )

  if ! command -v "$name" >/dev/null 2>&1; then
    echo "  ! $name not found on PATH. To register cempala manually once $name is installed, run:"
    # Quote the path — it is absolute and may contain spaces, and this line
    # exists to be copy-pasted.
    echo "      $name mcp add cempala ${flags[*]} -- \"$bin\""
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
  echo "      $name mcp add cempala ${flags[*]} -- \"$bin\""
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
