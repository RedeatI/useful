<#
.SYNOPSIS
  Exercise five action shortcuts through COM, ShellExecute, relocation, repair, and deletion.
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$artifactDir = Join-Path $RepoRoot "artifacts\shortcut-smoke\$timestamp"
$unicodeDesktop = -join @([char]0x684C, [char]0x9762)
$unicodeApp = -join @([char]0x5DE5, [char]0x5177, [char]0x7BB1)
$testRoot = Join-Path $env:TEMP "Useful Phase12.1\shortcut-$timestamp"
$desktop = Join-Path $testRoot "$unicodeDesktop Path"
$initialDir = Join-Path $testRoot "$unicodeApp App Initial"
$movedDir = Join-Path $testRoot "$unicodeApp App Moved"
$initialExe = Join-Path $initialDir "Useful.exe"
$movedExe = Join-Path $movedDir "Useful.exe"
. (Join-Path $RepoRoot "scripts\resolve-cargo-target.ps1")
$releaseBins = Resolve-UsefulReleaseBinaries -RepoRoot $RepoRoot
$debugBins = Resolve-UsefulReleaseBinaries -RepoRoot $RepoRoot -Profile "debug"
$sourceExe = $releaseBins.UsefulExe
$helper = Join-Path $debugBins.ProfileDirectory "examples\shortcut_smoke.exe"
$receiptBeforeMove = Join-Path $artifactDir "receipts-before-move.jsonl"
$receiptAfterMove = Join-Path $artifactDir "receipts-after-move.jsonl"
$commit = (& git -C $RepoRoot rev-parse HEAD).Trim()
$previousReceiptEnv = $env:USEFUL_NATIVE_ACTION_RECEIPTS
$exitCode = 1

$actions = @(
  [pscustomobject]@{ id = "builtin.utilities.base64"; name = "Base64"; route = "/tools/utilities/base64" },
  [pscustomobject]@{ id = "builtin.utilities.json"; name = "JSON Formatter"; route = "/tools/utilities/json" },
  [pscustomobject]@{ id = "builtin.utilities.uuid"; name = "UUID"; route = "/tools/utilities/uuid" },
  [pscustomobject]@{ id = "builtin.utilities.hash"; name = "Hash"; route = "/tools/utilities/hash" },
  [pscustomobject]@{ id = "builtin.utilities.timestamp"; name = "Timestamp"; route = "/tools/utilities/timestamp" }
)

function Invoke-Helper([string[]]$Arguments) {
  & $helper @Arguments
  if ($LASTEXITCODE -ne 0) { throw "shortcut helper failed: $($Arguments -join ' ')" }
}

function Get-TestInstances([string]$ExePath) {
  @(Get-CimInstance Win32_Process | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.Equals($ExePath, [System.StringComparison]::OrdinalIgnoreCase)
    })
}

function Wait-ReceiptCount([string]$Path, [int]$Expected) {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline) {
    $count = if (Test-Path -LiteralPath $Path) { @(Get-Content -LiteralPath $Path).Count } else { 0 }
    if ($count -ge $Expected) { return }
    Start-Sleep -Milliseconds 200
  }
  throw "Timed out waiting for receipt $Expected in $Path"
}

function Assert-Receipts([string]$Path, $ExpectedActions) {
  $actual = @(Get-Content -LiteralPath $Path -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
  if ($actual.Count -ne $ExpectedActions.Count) {
    throw "Receipt count mismatch: expected=$($ExpectedActions.Count), actual=$($actual.Count)"
  }
  for ($index = 0; $index -lt $ExpectedActions.Count; $index++) {
    if ($actual[$index].actionId -ne $ExpectedActions[$index].id) {
      throw "Receipt action mismatch at $index"
    }
    if ($actual[$index].route -ne $ExpectedActions[$index].route) {
      throw "Receipt route mismatch at $index"
    }
    if (-not $actual[$index].rendered -or $actual[$index].title -eq "unknown") {
      throw "Receipt render assertion failed at $index"
    }
  }
}

function Stop-TestInstance([string]$ExePath) {
  $instances = @(Get-TestInstances $ExePath)
  foreach ($instance in $instances) {
    Stop-Process -Id $instance.ProcessId -Force -ErrorAction SilentlyContinue
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (@(Get-TestInstances $ExePath).Count -eq 0) { return }
    Start-Sleep -Milliseconds 200
  }
  throw "Useful instance did not exit: $ExePath"
}

function Start-ShortcutAndAssert([string]$LnkPath, [string]$ExePath, [string]$ReceiptPath, [int]$ExpectedCount) {
  Start-Process -FilePath $LnkPath | Out-Null
  Wait-ReceiptCount $ReceiptPath $ExpectedCount
  $instances = @(Get-TestInstances $ExePath)
  if ($instances.Count -ne 1) {
    throw "Expected one Useful instance, found $($instances.Count)"
  }
}

try {
  New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
  New-Item -ItemType Directory -Force -Path $desktop | Out-Null
  New-Item -ItemType Directory -Force -Path $initialDir | Out-Null

  if (-not $SkipBuild) {
    Push-Location $RepoRoot
    try {
      $previousEap = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      & pnpm --filter "@useful/app" tauri build --no-bundle --features native-test
      $buildCode = $LASTEXITCODE
      if ($buildCode -ne 0) {
        $ErrorActionPreference = $previousEap
        throw "Tauri native-test Release build failed: $buildCode"
      }
      & cargo build -p useful-shortcuts --example shortcut_smoke
      $helperBuildCode = $LASTEXITCODE
      $ErrorActionPreference = $previousEap
      if ($helperBuildCode -ne 0) { throw "shortcut helper build failed: $helperBuildCode" }
    } finally {
      $ErrorActionPreference = "Stop"
      Pop-Location
    }
  }
  if (-not (Test-Path -LiteralPath $sourceExe)) { throw "Release client not found: $sourceExe" }
  if (-not (Test-Path -LiteralPath $helper)) { throw "Shortcut helper not found: $helper" }

  Copy-Item -LiteralPath $sourceExe -Destination $initialExe
  New-Item -ItemType File -Force -Path (Join-Path $initialDir "portable.flag") | Out-Null

  $links = @()
  foreach ($action in $actions) {
    Invoke-Helper @("create", $initialExe, $desktop, $action.id, $action.name) | Out-Null
    $lnk = Join-Path $desktop "$($action.name).lnk"
    if (-not (Test-Path -LiteralPath $lnk)) { throw "Shortcut was not created: $lnk" }
    Invoke-Helper @("inspect", $lnk, $initialExe, $action.id) | Out-Null
    $links += $lnk
  }
  $beforeCopy = Join-Path $artifactDir "lnk-before-move"
  New-Item -ItemType Directory -Force -Path $beforeCopy | Out-Null
  Copy-Item -LiteralPath $links -Destination $beforeCopy

  $env:USEFUL_NATIVE_ACTION_RECEIPTS = $receiptBeforeMove
  for ($index = 0; $index -lt $links.Count; $index++) {
    Start-ShortcutAndAssert $links[$index] $initialExe $receiptBeforeMove ($index + 1)
  }
  Start-ShortcutAndAssert $links[0] $initialExe $receiptBeforeMove 6
  Assert-Receipts $receiptBeforeMove @($actions + $actions[0])
  Stop-TestInstance $initialExe

  Move-Item -LiteralPath $initialDir -Destination $movedDir
  if (-not (Test-Path -LiteralPath $movedExe)) { throw "Moved executable is missing" }
  for ($index = 0; $index -lt $links.Count; $index++) {
    $action = $actions[$index]
    Invoke-Helper @("repair", $movedExe, $links[$index], $action.id, $action.name) | Out-Null
    Invoke-Helper @("inspect", $links[$index], $movedExe, $action.id) | Out-Null
  }
  $afterCopy = Join-Path $artifactDir "lnk-after-repair"
  New-Item -ItemType Directory -Force -Path $afterCopy | Out-Null
  Copy-Item -LiteralPath $links -Destination $afterCopy

  $env:USEFUL_NATIVE_ACTION_RECEIPTS = $receiptAfterMove
  for ($index = 0; $index -lt $links.Count; $index++) {
    Start-ShortcutAndAssert $links[$index] $movedExe $receiptAfterMove ($index + 1)
  }
  Assert-Receipts $receiptAfterMove $actions
  Stop-TestInstance $movedExe

  foreach ($lnk in $links) {
    Invoke-Helper @("delete", $lnk) | Out-Null
  }
  if (@(Get-ChildItem -LiteralPath $desktop -Filter "*.lnk" -File).Count -ne 0) {
    throw "Shortcut files remain after deletion"
  }
  if (@(Get-TestInstances $initialExe).Count -ne 0 -or @(Get-TestInstances $movedExe).Count -ne 0) {
    throw "Useful process remains after shortcut smoke"
  }

  $result = [pscustomobject]@{
    scenario = "windows-action-shortcuts"
    commit = $commit
    total = $actions.Count
    passed = $actions.Count
    failed = 0
    coldStart = $actions[0].id
    singleInstanceSequence = @($actions | ForEach-Object { $_.id })
    repairedAfterMove = $actions.Count
    deleted = $actions.Count
    chineseDesktop = $true
    spacedUsefulPath = $true
    shellExecute = $true
    comIShellLink = $true
    artifacts = @("lnk-before-move", "lnk-after-repair", "receipts-before-move.jsonl", "receipts-after-move.jsonl")
  }
  ConvertTo-Json -InputObject $result -Depth 8 | Set-Content -LiteralPath (Join-Path $artifactDir "result.json") -Encoding UTF8
  @(
    "# Windows Action Shortcut Smoke",
    "",
    "- commit: $commit",
    "- shortcuts: 5/5",
    "- create/inspect/ShellExecute/single-instance: PASS",
    "- relocate/repair/relaunch: PASS",
    "- delete/cleanup: PASS"
  ) | Set-Content -LiteralPath (Join-Path $artifactDir "summary.md") -Encoding UTF8
  Write-Host "[ OK ] Windows action shortcut smoke: 5/5"
  Write-Host "Evidence: $artifactDir"
  $exitCode = 0
} catch {
  Write-Host "[FAIL] $($_.Exception.Message)" -ForegroundColor Red
  $exitCode = 1
} finally {
  try { Stop-TestInstance $initialExe } catch {}
  try { Stop-TestInstance $movedExe } catch {}
  if ($null -eq $previousReceiptEnv) {
    Remove-Item Env:\USEFUL_NATIVE_ACTION_RECEIPTS -ErrorAction SilentlyContinue
  } else {
    $env:USEFUL_NATIVE_ACTION_RECEIPTS = $previousReceiptEnv
  }
  $resolvedTestRoot = Resolve-Path -LiteralPath $testRoot -ErrorAction SilentlyContinue
  if ($resolvedTestRoot) {
    $allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $env:TEMP "Useful Phase12.1"))
    $resolvedPath = [System.IO.Path]::GetFullPath($resolvedTestRoot.Path)
    if ($resolvedPath.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -Recurse -Force -LiteralPath $resolvedPath -ErrorAction SilentlyContinue
    }
  }
}

exit $exitCode
