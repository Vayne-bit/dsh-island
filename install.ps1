# Registers this folder as a plugin of a DSH profile.
# Usage:  powershell -ExecutionPolicy Bypass -File install.ps1 [-Profile desktop] [-Cli <path\to\dsh.cmd>]
param(
  [string]$Profile = "desktop",
  [string]$Cli = ""
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
if (-not $here) { $here = (Get-Location).Path }

function Find-Cli {
  $roots = @(
    (Join-Path $env:LOCALAPPDATA "Programs"),
    "C:\Program Files",
    "C:\Program Files (x86)"
  )
  foreach ($r in $roots) {
    $p = Join-Path $r "DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
    if (Test-Path $p) { return $p }
  }
  return $null
}

if (-not $Cli) { $Cli = Find-Cli }
if (-not $Cli -or -not (Test-Path $Cli)) {
  throw "dsh.cmd not found. Re-run with -Cli <full path to dsh.cmd under the DSH install dir>."
}

Write-Host "plugin : $here"
Write-Host "profile: $Profile"
Write-Host "cli    : $Cli"
& $Cli plugin --profile $Profile add ("link:" + $here)
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "Done. Restart DSH (quit from the tray, then start it again) to load the plugin."
Write-Host "Uninstall: & `"$Cli`" plugin --profile $Profile remove dsh-island-overlay"
