#!/usr/bin/env bash
# scripts/build-all.sh — cross-compile all six release targets.
#
# Per AGENTS.md §7. Each target needs a real smoke test on matching
# hardware (native machine or VM) before being tagged as a release
# artifact — a successful build proves nothing about the artifact
# because the binary can't be run on the build host if the target
# arch differs.
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

echo ""
echo "✓ all targets built. Artifacts in dist/:"
ls -l dist/ | tail -n +2
echo ""
echo "Reminder: each target needs a smoke test on matching hardware before"
echo "being tagged as a release artifact."
