# scripts/uninstall.ps1 -- cempala uninstaller for Windows
#
# The counterpart to install.ps1, and the reason it exists is the same as on
# Unix: deleting the install directory was never enough. The installer writes
# to five places, and four of them are other programs' config files:
#
#   1. %USERPROFILE%\.cempala\   the binary, the config, the database
#   2. the user PATH variable    the bin directory
#   3. Claude Code and Codex     an MCP server registration each
#   4. Antigravity               an entry in .gemini\config\mcp_config.json
#   5. OpenCode                  an entry in .config\opencode\opencode.json[c]
#
# Remove only (1) and the four registrations survive, each pointing at a
# binary that is gone -- so every launch of every agent CLI reports cempala
# as a failed server until the user hunts down four config files.
#
# Registrations are removed with each CLI's OWN tool so their config files
# stay theirs. Antigravity and OpenCode ship no such command, so those two
# are edited directly -- by the binary, which removes one key from each and
# leaves the rest alone.
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

# Set when a cleanup step fails. It changes two things at the end: the
# binary is KEPT (it is the only thing that can retry the step that
# failed), and the closing banner reports a partial uninstall instead of
# claiming success over the top of a warning.
$cleanupFailed = $false

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
    # A GENUINE failure counts as a failed cleanup. Warning and carrying on
    # meant the binary was deleted anyway and the run ended with a success
    # banner, leaving a live registration pointing at nothing.
    $script:cleanupFailed = $true
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
    # The exit code was ignored here, so a crash or a failed write was
    # followed by the global success banner all the same.
    if ($r.ExitCode -ne 0) {
      $cleanupFailed = $true
      Write-Host "  ! antigravity unregistration failed; edit $agConfig by hand"
    }
  }
} elseif ((Test-Path $agConfig) -and (Select-String -Path $agConfig -Pattern '"cempala"' -Quiet)) {
  # A registration we could not remove is LIVE CONFIGURATION LEFT BEHIND,
  # not a note in passing. Carrying on let the run end with a success
  # banner -- and under -Purge it would delete the database while
  # Antigravity still pointed at a binary about to vanish.
  $cleanupFailed = $true
  Write-Host "  ! this cempala build cannot unregister itself from Antigravity."
  Write-Host "    Remove the `"cempala`" entry from `"mcpServers`" in:"
  Write-Host "      $agConfig"
} else {
  Write-Host "  [ok] cempala was not registered with Antigravity"
}

# --- 3. Unregister from OpenCode --------------------------------------------
#
# The installer registers OpenCode through its own `opencode mcp add`, but
# there is no `opencode mcp remove` to undo it, so this half goes through
# the binary like Antigravity's. Registering automatically without being
# able to unregister is the failure this script exists to prevent.
#
# Three filenames are checked in the fallback: `opencode mcp add` writes to
# an existing opencode.json and otherwise creates opencode.jsonc, and
# config.json is a legacy name OpenCode still loads.
# $env:USERPROFILE, NOT $HOME. Windows PowerShell 5.1 builds $HOME from
# HOMEDRIVE+HOMEPATH, which on a domain or roaming profile is a network
# share -- while the binary resolves its own paths through os.homedir(),
# which reads USERPROFILE. Disagreeing here would send the fallback to
# scan the wrong directory, find nothing, print "not registered", and let
# the run delete the binary with a live entry still on disk: a false
# success in the one branch that exists to catch this.
$ocDir = if ($env:XDG_CONFIG_HOME) {
  Join-Path $env:XDG_CONFIG_HOME "opencode"
} else {
  Join-Path $env:USERPROFILE ".config\opencode"
}
$canUnregisterOc = $false
if (Test-Path $bin) {
  $help = Invoke-Cli -Exe $bin -CliArgs @("--help")
  $canUnregisterOc = $help.Output -match "--unregister-opencode"
}
if ($canUnregisterOc) {
  if ($DryRun) {
    Write-Host "    would run: $bin --unregister-opencode"
  } else {
    $r = Invoke-Cli -Exe $bin -CliArgs @("--unregister-opencode")
    if ($r.Output) { Write-Host $r.Output }
    if ($r.ExitCode -ne 0) {
      $cleanupFailed = $true
      Write-Host "  ! opencode unregistration failed; edit the config in $ocDir by hand"
    }
  }
} else {
  $ocLeft = @()
  foreach ($name in @("opencode.json", "opencode.jsonc", "config.json")) {
    $ocConfig = Join-Path $ocDir $name
    if ((Test-Path $ocConfig) -and (Select-String -Path $ocConfig -Pattern '"cempala"' -Quiet)) {
      $ocLeft += $ocConfig
    }
  }
  if ($ocLeft.Count -gt 0) {
    $cleanupFailed = $true
    Write-Host "  ! this cempala build cannot unregister itself from OpenCode."
    Write-Host "    Remove the `"cempala`" entry from `"mcp`" in:"
    foreach ($ocConfig in $ocLeft) { Write-Host "      $ocConfig" }
  } else {
    Write-Host "  [ok] cempala was not registered with OpenCode"
  }
}

# --- 4. Remove the bin directory from the user PATH -------------------------
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
  # Drop ONLY our own entries -- ours and the legacy %LOCALAPPDATA% one
  # install.ps1 also cleans up. Everything else is kept exactly as found,
  # INCLUDING empty components.
  #
  # Filtering empty entries out as well looked like tidying and was a bug
  # twice over. A user PATH ending in a trailing semicolon splits to a
  # final empty element, so the count changed even when cempala was never
  # on PATH -- and the script would then rewrite a PATH it had no business
  # touching and report "removed it", having removed nothing of ours.
  $legacyBin = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Cempala\bin" } else { $null }
  $isOurs = {
    param($entry)
    $e = $entry.TrimEnd('\')
    ($e -eq $binDir.TrimEnd('\')) -or ($legacyBin -and $e -eq $legacyBin.TrimEnd('\'))
  }
  $parts   = $userPath -split ';'
  $kept    = @($parts | Where-Object { -not (& $isOurs $_) })
  $dropped = $parts.Count - $kept.Count

  if ($dropped -eq 0) {
    Write-Host "  . cempala was not on your user PATH"
  } elseif ($DryRun) {
    Write-Host "    would remove $dropped cempala entr$(if ($dropped -eq 1) { 'y' } else { 'ies' }) from the user PATH"
  } else {
    [Environment]::SetEnvironmentVariable("PATH", ($kept -join ';'), "User")
    Write-Host "  [ok] removed it from the user PATH"
  }
}

# --- 5. The legacy install location -------------------------------------------
#
# install.ps1 cleans up %LOCALAPPDATA%\Cempala\bin, which is where the
# original builds put the binary. Someone uninstalling may never have run
# a version that migrated them off it, so an uninstaller that only knows
# the current location leaves that copy behind forever.
if ($env:LOCALAPPDATA) {
  $legacyHome = Join-Path $env:LOCALAPPDATA "Cempala"
  if (Test-Path $legacyHome) {
    Write-Host ""
    Write-Host "-> removing the legacy install at $legacyHome"
    if ($DryRun) {
      Write-Host "    would remove $legacyHome"
    } else {
      Remove-Item -Path $legacyHome -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path $legacyHome) {
        $cleanupFailed = $true
        Write-Host "  ! could not remove $legacyHome (in use?); delete it by hand"
      } else {
        Write-Host "  [ok] removed $legacyHome"
      }
    }
  }
}

# --- 6. The install directory --------------------------------------------------
Write-Host ""
if ($Purge -and $cleanupFailed) {
  # PURGE IS SKIPPED when a step failed. -Purge deletes the binary along
  # with everything else, so purging after a failure removes the one tool
  # able to retry -- while destroying the database irreversibly, on a
  # system left half uninstalled. Refusing is recoverable; this is not.
  Write-Host "-> NOT purging: a step above failed"
  Write-Host "  . $cempalaHome was left alone, including your data"
  Write-Host "    Fix what is reported above, then re-run with -Purge."
} elseif ($Purge) {
  Write-Host "-> removing .cempala (including the database and audit log)"
  if ($DryRun) {
    Write-Host "    would remove $cempalaHome"
  } elseif (Test-Path $cempalaHome) {
    # VERIFY, do not assume. -ErrorAction SilentlyContinue swallowed every
    # failure here and the next line printed success regardless — so a
    # locked cempala.db left the directory on disk while the script said
    # it was gone. That is worst precisely for -Purge, whose whole promise
    # is that the database and audit log are deleted.
    Remove-Item -Path $cempalaHome -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $cempalaHome) {
      $cleanupFailed = $true
      Write-Host "  ! could not fully remove $cempalaHome"
      Write-Host "    Something in it is still in use — close any running agent session and"
      Write-Host "    delete the folder by hand. Your data has NOT been removed."
    } else {
      Write-Host "  [ok] removed $cempalaHome"
    }
  } else {
    Write-Host "  . $cempalaHome does not exist"
  }
} elseif ($cleanupFailed) {
  # Where a binary exists it is what would retry, so it stays. Where there
  # is not one, say so rather than claiming to have kept something absent.
  if (Test-Path $bin) {
    Write-Host "-> keeping the binary: a cleanup step failed and you will need it to retry"
    Write-Host "  . left $bin in place"
  } else {
    Write-Host "-> no binary to remove"
    Write-Host "  . a cleanup step failed; see above for what to finish by hand"
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
          $cleanupFailed = $true
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
if ($cleanupFailed) {
  Write-Host "! cempala was PARTIALLY uninstalled."
  Write-Host ""
  Write-Host "One or more steps above could not be completed."
  if (Test-Path $bin) {
    Write-Host "The binary was kept so you can retry:"
    Write-Host "  $bin"
    Write-Host "Fix what the message above reports, then re-run this script."
  } else {
    Write-Host "There is no cempala binary able to finish the job on this machine,"
    Write-Host "so the remaining steps have to be done by hand -- see above for"
    Write-Host "exactly which files and lines."
  }
  exit 1
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
