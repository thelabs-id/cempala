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
register() {
  local name="$1"
  local cmd="$2"
  if command -v "$name" >/dev/null 2>&1; then
    echo "→ $name found, registering cempala as an MCP server"
    if "$name" $cmd; then
      echo "  ✓ $name mcp add succeeded"
    else
      echo "  ! $name mcp add failed (rc=$?) — you may need to re-run it manually"
    fi
  else
    echo "  ! $name not found on PATH. To register cempala manually once $name is installed, run:"
    echo "      $name $cmd"
  fi
}

register claude "mcp add cempala --scope user -- cempala"
register codex  "mcp add cempala -- cempala"

cat <<'EOF'

✓ cempala installed.

Next steps:
  - Start a new shell (or `source` your rc file) so `cempala` is on PATH.
  - In Claude Code or Codex, run `<cli> mcp list` to confirm cempala is registered.
  - From any project under your home directory, dispatch or message the other agent.
  - For paths outside your home, call `approve_path` after the human confirms.

To re-run this installer (e.g. to upgrade), it's safe — the binary is
overwritten in place and the MCP registrations are idempotent.
EOF
