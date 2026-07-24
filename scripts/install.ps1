# scripts/install.ps1 — cempala installer for Windows
#
# Per FR-18..FR-22. Non-interactive, idempotent, designed to be piped from
# `irm https://raw.githubusercontent.com/thelabs-id/cempala/main/scripts/install.ps1 | iex`.
#
# Steps (per AGENTS.md §8):
#   1. $env:PROCESSOR_ARCHITECTURE → maps to cempala-windows-{x64,arm64}.exe.
#   2. Invoke-WebRequest to download, Get-FileHash to verify checksum.
#   3. Install to %LOCALAPPDATA%\Cempala\bin.
#   4. $env:Path = "$env:LOCALAPPDATA\Cempala\bin;$env:Path" in this session
#      AND [Environment]::SetEnvironmentVariable("PATH", ..., "User") for
#      persistence across future sessions.
#   5. Run cempala --init to write the default config if absent.
#   6. Detect claude / codex, run matching mcp add for each; print the
#      manual command for each not found.

$ErrorActionPreference = "Stop"

# --- 1. Detect architecture ---
switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64"  { $arch = "x64";   break }
  "ARM64"  { $arch = "arm64"; break }
  default {
    Write-Error "error: unsupported architecture: $env:PROCESSOR_ARCHITECTURE"
    exit 1
  }
}
$asset = "cempala-windows-${arch}.exe"
Write-Host "→ detected platform: windows-${arch}"

# --- 2. Locate the GitHub release tag ---
if (-not $env:CEMPALA_VERSION) { $env:CEMPALA_VERSION = "latest" }
$repo = "thelabs-id/cempala"
if ($env:CEMPALA_VERSION -eq "latest") {
  $releaseUrl = "https://github.com/${repo}/releases/latest/download"
} else {
  $releaseUrl = "https://github.com/${repo}/releases/download/${env:CEMPALA_VERSION}"
}

$tmpdir = Join-Path $env:TEMP ("cempala-install-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $tmpdir -Force | Out-Null

try {
  Write-Host "→ downloading $asset ($env:CEMPALA_VERSION)"
  Invoke-WebRequest -Uri "${releaseUrl}/${asset}" -OutFile "${tmpdir}\${asset}" -UseBasicParsing
  Invoke-WebRequest -Uri "${releaseUrl}/checksums.txt" -OutFile "${tmpdir}\checksums.txt" -UseBasicParsing

  # --- Verify the binary against checksums.txt BEFORE doing anything with it. ---
  Write-Host "→ verifying sha-256"
  $checksumLines = Get-Content "${tmpdir}\checksums.txt"
  $expected = $null
  foreach ($line in $checksumLines) {
    if ($line -match "^[a-f0-9]+\s+\*?${asset}$") {
      $expected = ($line -split '\s+')[0]
      break
    }
  }
  if (-not $expected) {
    Write-Error "error: no checksum found for ${asset} in checksums.txt"
    exit 1
  }
  $actual = (Get-FileHash -Path "${tmpdir}\${asset}" -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) {
    Write-Error "error: sha-256 mismatch for ${asset}`n  expected: $expected`n  actual:   $actual"
    exit 1
  }
  Write-Host "  ✓ checksum verified"

  # --- 3. Install to %LOCALAPPDATA%\Cempala\bin ---
  $binDir = Join-Path $env:LOCALAPPDATA "Cempala\bin"
  New-Item -ItemType Directory -Path $binDir -Force | Out-Null
  $dest = Join-Path $binDir "cempala.exe"
  Move-Item -Path "${tmpdir}\${asset}" -Destination $dest -Force
  Write-Host "→ installed to $dest"

  # --- 4. PATH for this session AND future sessions ---
  $env:Path = "$binDir;$env:Path"

  # Read the current user PATH, then prepend our bin dir, then persist.
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath) { $userPath = "" }
  if ($userPath -notlike "*$binDir*") {
    $newUserPath = "$binDir;$userPath"
    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
    Write-Host "→ appended $binDir to user PATH (restart shells to take effect)"
  } else {
    Write-Host "→ user PATH already contains $binDir"
  }

  # --- 5. cempala --init ---
  Write-Host "→ running cempala --init"
  & $dest --init

  # --- 6. Auto-register with claude / codex where present ---
  function Register-Agent {
    param([string]$Name, [string]$CmdArgs)
    $exe = Get-Command $Name -ErrorAction SilentlyContinue
    if ($exe) {
      Write-Host "→ $Name found, registering cempala as an MCP server"
      # Use cmd /c to resolve the .cmd/.ps1 shim that npm installs
      # (`Start-Process -FilePath codex` fails with "is not a valid Win32
      # application" on a .ps1 shim; `cmd /c codex ...` walks PATHEXT
      # the way users expect). Capture the exit code via $LASTEXITCODE.
      cmd /c "$Name $CmdArgs" *> $null
      $exit = $LASTEXITCODE
      if ($exit -eq 0) {
        Write-Host "  ✓ $Name mcp add succeeded"
      } else {
        Write-Host "  ! $Name mcp add failed (exit=$exit) — you may need to re-run it manually:"
        Write-Host "      $Name $CmdArgs"
      }
    } else {
      Write-Host "  ! $Name not found on PATH. To register cempala manually once $Name is installed, run:"
      Write-Host "      $Name $CmdArgs"
    }
  }

  Register-Agent -Name "claude" -CmdArgs "mcp add cempala --scope user -- cempala"
  Register-Agent -Name "codex"  -CmdArgs "mcp add cempala -- cempala"

  Write-Host ""
  Write-Host "✓ cempala installed."
  Write-Host ""
  Write-Host "Next steps:"
  Write-Host "  - Open a new PowerShell window so cempala is on PATH."
  Write-Host "  - In Claude Code or Codex, run '<cli> mcp list' to confirm cempala is registered."
  Write-Host "  - From any project under your home directory, dispatch or message the other agent."
  Write-Host "  - For paths outside your home, call approve_path after the human confirms."
  Write-Host ""
  Write-Host "To re-run this installer (e.g. to upgrade), it's safe — the binary is"
  Write-Host "overwritten in place and the MCP registrations are idempotent."
} finally {
  if (Test-Path $tmpdir) {
    Remove-Item -Path $tmpdir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
