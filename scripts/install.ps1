# scripts/install.ps1 -- cempala installer for Windows
#
# Per FR-18..FR-22. Non-interactive, idempotent, designed to be piped from
# `irm https://raw.githubusercontent.com/thelabs-id/cempala/main/scripts/install.ps1 | iex`.
#
# Steps:
#   1. $env:PROCESSOR_ARCHITECTURE -> maps to cempala-windows-{x64,arm64}.exe.
#   2. Invoke-WebRequest to download, Get-FileHash to verify checksum.
#   3. Install to %USERPROFILE%\.cempala\bin -- NOT AppData, see step 3 below.
#   4. $env:Path = "$env:USERPROFILE\.cempala\bin;$env:Path" in this session
#      AND [Environment]::SetEnvironmentVariable("PATH", ..., "User") for
#      persistence across future sessions.
#   5. Run cempala --init to write the default config if absent.
#   6. Detect claude / codex, run matching mcp add for each; print the
#      manual command for each not found. Antigravity has no `mcp add`, so
#      `cempala --register-antigravity` merges the entry into
#      %USERPROFILE%\.gemini\config\mcp_config.json instead.

$ErrorActionPreference = "Stop"

# --- 1. Detect architecture ---
#
# ARM64 deliberately maps to the x64 asset. A native windows-arm64 binary
# builds fine, but a target is not a release artifact
# until it has been smoke-tested on matching hardware, and that has not
# happened yet -- so it is not published. Windows on ARM runs x64 binaries
# under emulation, so pointing ARM64 machines at the verified x64 build gives
# them something that actually works, instead of a 404 for an asset that does
# not exist. Give ARM64 its own line here the moment a native build is
# published and tested.
switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64"  { $arch = "x64"; break }
  "ARM64"  { $arch = "x64"; $emulated = $true; break }
  default {
    Write-Error "error: unsupported architecture: $env:PROCESSOR_ARCHITECTURE"
    exit 1
  }
}
$asset = "cempala-windows-${arch}.exe"
if ($emulated) {
  Write-Host "-> detected platform: windows-arm64; installing the x64 build (runs under emulation)"
} else {
  Write-Host "-> detected platform: windows-${arch}"
}

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
  Write-Host "-> downloading $asset ($env:CEMPALA_VERSION)"
  Invoke-WebRequest -Uri "${releaseUrl}/${asset}" -OutFile "${tmpdir}\${asset}" -UseBasicParsing
  Invoke-WebRequest -Uri "${releaseUrl}/checksums.txt" -OutFile "${tmpdir}\checksums.txt" -UseBasicParsing

  # --- Verify the binary against checksums.txt BEFORE doing anything with it. ---
  Write-Host "-> verifying sha-256"
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
  Write-Host "  [ok] checksum verified"

  # --- 3. Install to %USERPROFILE%\.cempala\bin ---
  #
  # NOT %LOCALAPPDATA%. That was the original location and it is actively
  # broken for the thing cempala exists to do: some agent clients run their
  # MCP child processes with a redirected view of AppData\Local, so a binary
  # installed there is INVISIBLE to them. The symptom is baffling from the
  # outside -- the client reports the server as "failed", every manual check
  # passes, and the file is plainly on disk. What settles it is asking the
  # child itself: a `cmd /c if exist ...` inside the spawned process reports
  # NO for a path that unquestionably exists, and the launcher exits 3
  # (ERROR_PATH_NOT_FOUND).
  #
  # %USERPROFILE%\.cempala\bin is outside AppData and visible to those
  # children, and it matches what install.sh already uses on macOS and Linux,
  # so both installers now agree on where cempala lives.
  $binDir = Join-Path $env:USERPROFILE ".cempala\bin"
  New-Item -ItemType Directory -Path $binDir -Force | Out-Null
  $dest = Join-Path $binDir "cempala.exe"

  # Windows locks a running executable: it can be neither deleted nor
  # overwritten. Any agent currently holding cempala open as an MCP server owns
  # that lock -- which is the NORMAL case when upgrading, so a plain
  # `Move-Item -Force` fails with "Cannot create a file when that file already
  # exists" and takes the whole install with it. FR-22 says re-running has to
  # be safe, and that has to hold while cempala is in use, not only when it is
  # idle.
  #
  # A locked exe can still be RENAMED, so move the old one aside and drop the
  # new one into place. The running server keeps using the renamed file until
  # it exits, which is exactly what we want -- no need to kill anyone's session
  # to upgrade.
  if (Test-Path $dest) {
    $stale = "cempala.exe.old-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
    try {
      Rename-Item -Path $dest -NewName $stale -ErrorAction Stop
    } catch {
      Write-Error "error: could not replace $dest (in use and not renamable): $_"
      exit 1
    }
  }
  Move-Item -Path "${tmpdir}\${asset}" -Destination $dest -Force
  Write-Host "-> installed to $dest"

  # Sweep any superseded binaries left by earlier upgrades. They unlock once
  # the agent session holding them exits, so this is best-effort by design:
  # whatever is still in use simply gets cleaned up by the next run.
  Get-ChildItem -Path $binDir -Filter "cempala.exe.old-*" -ErrorAction SilentlyContinue | ForEach-Object {
    try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch { }
  }

  # Clean up an install left by an earlier version in the old location, so a
  # stale binary can't shadow this one on PATH or linger as dead weight.
  $legacyBin = Join-Path $env:LOCALAPPDATA "Cempala\bin"
  if (Test-Path $legacyBin) {
    try {
      Remove-Item -Path (Join-Path $env:LOCALAPPDATA "Cempala") -Recurse -Force -ErrorAction Stop
      Write-Host "-> removed the previous install from $legacyBin"
    } catch {
      Write-Host "  ! could not remove the old install at $legacyBin (in use?); safe to delete by hand"
    }
  }

  # --- 4. PATH for this session AND future sessions ---
  $env:Path = "$binDir;$env:Path"

  # Read the current user PATH, drop any entry pointing at the old AppData
  # location, then prepend our bin dir and persist.
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath) { $userPath = "" }
  $entries = @($userPath -split ';' | Where-Object { $_ -ne "" -and $_ -ne $legacyBin })
  if ($entries -notcontains $binDir) {
    $newUserPath = (@($binDir) + $entries) -join ';'
    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
    Write-Host "-> added $binDir to user PATH (restart shells to take effect)"
  } elseif (($entries -join ';') -ne $userPath) {
    [Environment]::SetEnvironmentVariable("Path", ($entries -join ';'), "User")
    Write-Host "-> user PATH already contains $binDir (removed the stale entry)"
  } else {
    Write-Host "-> user PATH already contains $binDir"
  }

  # --- 5. cempala --init ---
  Write-Host "-> running cempala --init"
  & $dest --init

  # --- 6. Auto-register with claude / codex where present ---

  # Run a CLI and return its exit code + merged output.
  #
  # Takes the RESOLVED executable and a real argument array, rather than a
  # command string handed to cmd.exe. That matters now that we register an
  # absolute path: the install dir sits under the user's profile, so any
  # account with a space in its name produces a path that a hand-built
  # cmd.exe string would split in two. Passing an array lets PowerShell do
  # the quoting, which it gets right.
  #
  # Resolving the name first (Get-Command) also keeps the npm shims working:
  # `codex` is a .cmd, and calling its resolved path with & runs it correctly
  # without needing cmd.exe to walk PATHEXT for us.
  #
  # $ErrorActionPreference is dropped to Continue around the call. Redirecting
  # a native command's stderr wraps each line in a NativeCommandError, which
  # under the script-wide "Stop" is terminating -- so a CLI that merely prints
  # a warning to stderr would abort the whole installer instead of reaching
  # the error branch below. We need stderr, because that is where the CLIs
  # write "already exists".
  # Render an argument array as a copy-pasteable command line. The binary path
  # is absolute and may contain spaces, so any argument containing one has to
  # come back quoted or the printed fallback command would not work.
  function Format-CliHint {
    param([string[]]$CliArgs)
    ($CliArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  }

  function Invoke-Cli {
    param([string]$Exe, [string[]]$CliArgs)
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $out = & $Exe @CliArgs 2>&1
      return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = (($out | Out-String).Trim()) }
    } finally {
      $ErrorActionPreference = $prevEAP
    }
  }

  function Register-Agent {
    param([string]$Name, [string[]]$AddArgs, [string[]]$RemoveArgs)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) {
      Write-Host "  ! $Name not found on PATH. To register cempala manually once $Name is installed, run:"
      Write-Host "      $Name $(Format-CliHint $AddArgs)"
      return
    }
    $exe = $cmd.Source

    Write-Host "-> $Name found, registering cempala as an MCP server"
    $r = Invoke-Cli -Exe $exe -CliArgs $AddArgs

    # FR-22: re-running the installer must be safe. Not every CLI's
    # `mcp add` is idempotent -- `codex mcp add` updates in place and
    # exits 0, but `claude mcp add` exits 1 with "already exists" and has
    # no --force/--update flag. So for THAT failure specifically, remove the
    # existing registration and add it again. That also picks up a changed
    # command line on upgrade, which "already exists, skipping" would not.
    #
    # The match on the CLI's message is deliberately narrow. Reacting to any
    # non-zero exit would mean a transient failure (a locked config, a
    # permissions problem) causes us to DELETE a perfectly good registration
    # and then possibly fail to re-add it -- turning a working install into a
    # broken one. Leaving an existing registration untouched is always the
    # safe direction when we cannot identify the failure.
    if ($r.ExitCode -ne 0 -and $RemoveArgs -and $r.Output -match "already exists") {
      Invoke-Cli -Exe $exe -CliArgs $RemoveArgs | Out-Null
      $r = Invoke-Cli -Exe $exe -CliArgs $AddArgs
    }

    if ($r.ExitCode -eq 0) {
      Write-Host "  [ok] $Name mcp add succeeded"
    } else {
      Write-Host "  ! $Name mcp add failed (exit=$($r.ExitCode)) -- you may need to re-run it manually:"
      Write-Host "      $Name $(Format-CliHint $AddArgs)"
      if ($r.Output) { Write-Host "      $($r.Output)" }
    }
  }

  # Register the ABSOLUTE path, not the bare name `cempala`.
  #
  # A bare name makes the agent CLI resolve it through PATH at launch, and on
  # Windows a process gets a COPY of the environment when it starts. Install
  # cempala while Claude Code is already running and that process's PATH
  # predates the bin directory, so it cannot find the executable and shows the
  # server as "failed" -- with a working binary sitting on disk and a correct
  # registration. Nothing is wrong except where the client is looking.
  #
  # We know exactly where the binary was just placed, so there is no reason to
  # make the client rediscover it. An absolute path works regardless of PATH,
  # in any already-running client, forever.
  Register-Agent -Name "claude" -AddArgs @("mcp", "add", "cempala", "--scope", "user", "--", $dest) `
                                -RemoveArgs @("mcp", "remove", "cempala", "--scope", "user")
  Register-Agent -Name "codex"  -AddArgs @("mcp", "add", "cempala", "--", $dest) `
                                -RemoveArgs @("mcp", "remove", "cempala")

  # Antigravity has no `mcp add` subcommand -- `agy --help` lists agent,
  # changelog, help, install, models, plugin and update, and the docs say to
  # edit %USERPROFILE%\.gemini\config\mcp_config.json directly. cempala does
  # that merge itself so this script and install.sh do not each carry their
  # own copy of the rule; it preserves any servers already registered and
  # refuses to touch a config it cannot parse.
  #
  # Run unconditionally rather than only when `agy` is on PATH: the same file
  # is read by the Antigravity IDE, which many people install without the CLI.
  Write-Host "-> registering cempala with Antigravity"
  $agResult = Invoke-Cli -Exe $dest -CliArgs @("--register-antigravity", $dest)
  if ($agResult.Output) { Write-Host $agResult.Output }
  if ($agResult.ExitCode -ne 0) {
    Write-Host "  ! antigravity registration step failed; cempala is otherwise installed"
  }

  Write-Host ""
  Write-Host "[ok] cempala installed."
  Write-Host ""
  Write-Host "Next steps:"
  Write-Host "  - RESTART any Claude Code, Codex or Antigravity session that is already"
  Write-Host "    open, so it picks up the registration. Until you do, it will show"
  Write-Host "    cempala as failed."
  Write-Host "  - Then run '<cli> mcp list' to confirm cempala is connected (in"
  Write-Host "    Antigravity, type '/mcp' in the prompt, or check Settings ->"
  Write-Host "    Installed MCP Servers)."
  Write-Host "  - From any project under your home directory, dispatch or message the other agent."
  Write-Host "  - For paths outside your home, call approve_path after the human confirms."
  Write-Host ""
  Write-Host "  (cempala is on your PATH for new shells too, but the MCP registration"
  Write-Host "   points at the binary directly, so it does not depend on that.)"
  Write-Host ""
  Write-Host "To re-run this installer (e.g. to upgrade), it's safe -- the binary is"
  Write-Host "overwritten in place and the MCP registrations are idempotent."
} finally {
  if (Test-Path $tmpdir) {
    Remove-Item -Path $tmpdir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
