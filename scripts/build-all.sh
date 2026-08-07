#!/usr/bin/env bash
# scripts/build-all.sh — cross-compile all six release targets.
#
# Each target needs a real smoke test on matching hardware (native machine
# or VM) before being tagged as a release artifact — a successful build
# proves nothing about the artifact, because the binary can't be run on the
# build host if the target arch differs.
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p dist

targets=(
  "bun-darwin-arm64:cempala-darwin-arm64"
  "bun-darwin-x64:cempala-darwin-x64"
  "bun-linux-arm64:cempala-linux-arm64"
  "bun-linux-x64:cempala-linux-x64"
  "bun-windows-arm64:cempala-windows-arm64.exe"
  "bun-windows-x64:cempala-windows-x64.exe"
)

for entry in "${targets[@]}"; do
  bun_target="${entry%%:*}"
  out_name="${entry##*:}"
  echo "→ building $out_name ($bun_target)"
  bun build --compile src/index.ts --target="$bun_target" --outfile "dist/$out_name"
done

# --- checksums.txt ---
#
# Not optional, and not merely a nicety: BOTH installers download
# checksums.txt from the release and refuse to install without a matching
# line for their asset ("no checksum found for <asset>"). A release cut
# without this file fails at the verification step on every machine, so it
# is generated here rather than left as a manual step someone forgets.
#
# Format has to be what the installers parse:
#   - `<sha256>  <bare-filename>` — the Windows installer matches
#     ^[a-f0-9]+\s+\*?<asset>$, so the name must have no directory part
#     (hence generating from inside dist/) and the digest must be lowercase
#     hex. The optional `*` is the binary-mode marker some tools emit.
#
# Same tool selection as install.sh: macOS ships no sha256sum, and openssl
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

echo "→ writing dist/checksums.txt"
(
  cd dist
  : > checksums.txt
  for entry in "${targets[@]}"; do
    out_name="${entry##*:}"
    printf '%s  %s\n' "$(sha256_of "$out_name")" "$out_name" >> checksums.txt
  done
)

echo ""
echo "✓ all targets built. Artifacts in dist/:"
ls -l dist/ | tail -n +2
echo ""
cat dist/checksums.txt
echo ""
echo "Reminder: each target needs a smoke test on matching hardware before"
echo "being tagged as a release artifact."
echo "Upload the six binaries AND checksums.txt — the installers fail without it."
