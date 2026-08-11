# scripts/uninstall.ps1 -- cempala uninstaller for Windows
#
# The counterpart to install.ps1, and the reason it exists is the same as on
# Unix: deleting the install directory was never enough. The installer writes
# to four places, and three of them are other programs' config files:
#
#   1. %USERPROFILE%\.cempala\   the binary, the config, the database
#   2. the user PATH variable    the bin directory
#   3. Claude Code and Codex     an MCP server registration each
#   4. Antigravity               an entry in .gemini\config\mcp_config.json
#
# Remove only (1) and the three registrations survive, each pointing at a
# binary that is gone -- so every launch of every agent CLI reports cempala
# as a failed server until the user hunts down three config files.
#
# Registrations are removed with each CLI's OWN tool so their config files
# stay theirs. Only Antigravity, which ships no such command, is edited
# directly -- by the binary, which removes one key and leaves the rest alone.
#
# YOUR DATA IS KEPT unless you ask for it to go: .cempala holds the task
# history and audit log, which is a record rather than installation debris.
#
# Usage:
#   .\uninstall.ps1            remove the install, keep .cempala
#   .\uninstall.ps1 -Purge     also delete .cempala (data included)
#   .\uninstall.ps1 -DryRun    print what would happen, change nothing

[CmdletBinding()]
param(
  [switch]$Purge,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$cempalaHome = Join-Path $env:USERPROFILE ".cempala"
$binDir      = Join-Path $cempalaHome "bin"
$bin         = Join-Path $binDir "cempala.exe"
if (-not (Test-Path $bin)) {
  # Older installs dropped it without the extension.
  $alt = Join-Path $binDir "cempala"
  if (Test-Path $alt) { $bin = $alt }
}
$agConfig = Join-Path $env:USERPROFILE ".gemini\config\mcp_config.json"

Write-Host "cempala uninstaller"
if ($DryRun) { Write-Host "  (dry run -- nothing will be changed)" }
Write-Host ""

# Run a CLI and return exit code + merged output. $ErrorActionPreference is
# dropped to Continue because redirecting a native command's stderr wraps
# each line in a NativeCommandError, which under the script-wide "Stop"
# would abort the uninstaller on a mere warning. The empty pipeline closes
# the child's stdin -- a cempala older than these flags does not reject an
# unknown one, it starts the stdio MCP server and waits on input.
function Invoke-Cli {
  param([string]$Exe, [string[]]$CliArgs)
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = $null | & $Exe @CliArgs 2>&1
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = (($out | Out-String).Trim()) }
  } finally {
    $ErrorActionPreference = $prevEAP
  }
}

# --- 1. Unregister from Claude Code and Codex -------------------------------
function Unregister-Cli {
  param([string]$Name, [string[]]$RemoveArgs)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    Write-Host "  . $Name not on PATH; nothing to unregister"
    return
  }
  if ($DryRun) {
    Write-Host "    would run: $Name $($RemoveArgs -join ' ')"
    return
  }
  $r = Invoke-Cli -Exe $cmd.Source -CliArgs $RemoveArgs
  if ($r.ExitCode -eq 0) {
    Write-Host "  [ok] unregistered from $Name"
  } elseif ($r.Output -match "no mcp server|not found|does not exist") {
    Write-Host "  [ok] $Name had no cempala registration"
  } else {
    Write-Host "  ! could not unregister from $Name -- run it yourself:"
    Write-Host "      $Name $($RemoveArgs -join ' ')"
    if ($r.Output) { Write-Host "      $($r.Output)" }
  }
}

Write-Host "-> removing MCP registrations"
Unregister-Cli -Name "claude" -RemoveArgs @("mcp", "remove", "cempala", "--scope", "user")
Unregister-Cli -Name "codex"  -RemoveArgs @("mcp", "remove", "cempala")

# --- 2. Unregister from Antigravity -----------------------------------------
$canUnregister = $false
if (Test-Path $bin) {
  $help = Invoke-Cli -Exe $bin -CliArgs @("--help")
  $canUnregister = $help.Output -match "--unregister-antigravity"
}
if ($canUnregister) {
  if ($DryRun) {
    Write-Host "    would run: $bin --unregister-antigravity"
  } else {
    $r = Invoke-Cli -Exe $bin -CliArgs @("--unregister-antigravity")
    if ($r.Output) { Write-Host $r.Output }
  }
} elseif ((Test-Path $agConfig) -and (Select-String -Path $agConfig -Pattern '"cempala"' -Quiet)) {
  Write-Host "  ! this cempala build cannot unregister itself from Antigravity."
  Write-Host "    Remove the `"cempala`" entry from `"mcpServers`" in:"
  Write-Host "      $agConfig"
} else {
  Write-Host "  [ok] cempala was not registered with Antigravity"
}

# --- 3. Remove the bin directory from the user PATH -------------------------
#
# Only our own entry is dropped, matched exactly, and the rest of PATH is
# written back in its original order. PATH is shared with every other
# program on the machine; rebuilding it from a guess is how an uninstaller
# breaks unrelated software.
Write-Host ""
Write-Host "-> removing $binDir from your user PATH"
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ([string]::IsNullOrEmpty($userPath)) {
  Write-Host "  . user PATH is empty; nothing to remove"
} else {
  $parts = $userPath -split ';'
  $kept  = $parts | Where-Object { $_.TrimEnd('\') -ne $binDir.TrimEnd('\') -and $_ -ne "" }
  if ($kept.Count -eq $parts.Count) {
    Write-Host "  . $binDir was not on your user PATH"
  } elseif ($DryRun) {
    Write-Host "    would remove $binDir from the user PATH"
  } else {
    [Environment]::SetEnvironmentVariable("PATH", ($kept -join ';'), "User")
    Write-Host "  [ok] removed it from the user PATH"
  }
}

# --- 4. The install directory ------------------------------------------------
Write-Host ""
if ($Purge) {
  Write-Host "-> removing .cempala (including the database and audit log)"
  if ($DryRun) {
    Write-Host "    would remove $cempalaHome"
  } elseif (Test-Path $cempalaHome) {
    Remove-Item -Path $cempalaHome -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  [ok] removed $cempalaHome"
  }
} else {
  Write-Host "-> removing the binary, keeping your data"
  if (Test-Path $bin) {
    if ($DryRun) {
      Write-Host "    would remove $bin"
    } else {
      # A running server holds the file open, and Windows refuses to delete
      # an open executable. Renaming it aside always succeeds, gets it off
      # PATH immediately, and lets the old process finish on the copy it
      # already opened -- the same trick install.ps1 uses to upgrade.
      try {
        Remove-Item -Path $bin -Force
        Write-Host "  [ok] removed $bin"
      } catch {
        $aside = "$bin.old-$([System.IO.Path]::GetRandomFileName())"
        try {
          Rename-Item -Path $bin -NewName (Split-Path $aside -Leaf) -Force
          Write-Host "  [ok] cempala is still running, so its binary was renamed aside:"
          Write-Host "       $aside"
          Write-Host "       Delete it once you have closed the agent sessions using it."
        } catch {
          Write-Host "  ! could not remove $bin -- close any running agent session and delete it by hand"
        }
      }
    }
  } else {
    Write-Host "  . no binary at $bin"
  }
}

Write-Host ""
if ($DryRun) {
  Write-Host "[ok] dry run complete -- nothing was changed."
  return
}
Write-Host "[ok] cempala uninstalled."
Write-Host ""
if ((-not $Purge) -and (Test-Path $cempalaHome)) {
  Write-Host "Your data was kept, including the task history and audit log:"
  Write-Host "  $cempalaHome"
  Write-Host "Delete it yourself, or re-run with -Purge, to remove that too."
  Write-Host ""
}
Write-Host "RESTART any Claude Code, Codex or Antigravity session that is still open."
Write-Host "Until you do, each one keeps the server it already launched."
