<#
.SYNOPSIS
  Validate every action through cold-start CLI and rapid single-instance dispatch.
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$artifactDir = Join-Path $RepoRoot "artifacts\action-deeplink-smoke\$timestamp"
$testRoot = Join-Path $env:TEMP "Useful Phase12.1\deeplink-$timestamp"
$unicodeFolder = -join @([char]0x5DE5, [char]0x5177, [char]0x7BB1)
$appDir = Join-Path $testRoot "$unicodeFolder App Path"
$testExe = Join-Path $appDir "Useful.exe"
. (Join-Path $RepoRoot "scripts\resolve-cargo-target.ps1")
$sourceExe = (Resolve-UsefulReleaseBinaries -RepoRoot $RepoRoot).UsefulExe
$commit = (& git -C $RepoRoot rev-parse HEAD).Trim()
$previousReceiptEnv = $env:USEFUL_NATIVE_ACTION_RECEIPTS
$exitCode = 1

function Get-TestInstances {
  @(Get-CimInstance Win32_Process | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.Equals($testExe, [System.StringComparison]::OrdinalIgnoreCase)
    })
}

function Stop-TestInstances {
  foreach ($instance in @(Get-TestInstances)) {
    Stop-Process -Id $instance.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 300
}

function Wait-ReceiptCount([string]$Path, [int]$Expected) {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline) {
    $count = if (Test-Path -LiteralPath $Path) { @(Get-Content -LiteralPath $Path).Count } else { 0 }
    if ($count -ge $Expected) { return }
    Start-Sleep -Milliseconds 100
  }
  throw "Timed out waiting for receipt $Expected"
}

function Read-Receipts([string]$Path) {
  @(Get-Content -LiteralPath $Path -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
}

function Start-Action([string]$ActionId) {
  $arguments = '--open-action "{0}"' -f $ActionId.Replace('"', '\"')
  Start-Process -FilePath $testExe -ArgumentList $arguments | Out-Null
}

function Assert-OneInstance {
  $instances = @(Get-TestInstances)
  if ($instances.Count -ne 1) { throw "Expected one instance, found $($instances.Count)" }
}

try {
  New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
  New-Item -ItemType Directory -Force -Path $appDir | Out-Null

  $foreignUseful = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "Useful.exe" })
  if ($foreignUseful.Count -gt 0) {
    throw "PRECONDITION_BLOCKED: another Useful.exe is already running"
  }

  if (-not $SkipBuild) {
    Push-Location $RepoRoot
    try {
      $previousEap = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      & pnpm --filter "@useful/app" tauri build --no-bundle --features native-test
      $buildCode = $LASTEXITCODE
      $ErrorActionPreference = $previousEap
      if ($buildCode -ne 0) { throw "Tauri native-test Release build failed: $buildCode" }
    } finally {
      $ErrorActionPreference = "Stop"
      Pop-Location
    }
  }
  if (-not (Test-Path -LiteralPath $sourceExe)) { throw "Release client not found: $sourceExe" }
  Copy-Item -LiteralPath $sourceExe -Destination $testExe
  New-Item -ItemType File -Force -Path (Join-Path $appDir "portable.flag") | Out-Null

  $nativeResult = Get-ChildItem -Path (Join-Path $RepoRoot "artifacts\native-smoke\*\result.json") -File |
    Sort-Object LastWriteTimeUtc -Descending |
    ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName -Encoding UTF8 | ConvertFrom-Json } |
    Where-Object { $_.commit -eq $commit -and [int]$_.failed -eq 0 } |
    Select-Object -First 1
  if (-not $nativeResult) { throw "No passing native smoke result for current commit" }
  $actions = @($nativeResult.checks | Where-Object {
      $_.id -like "builtin.utilities.*" -or $_.id -like "builtin.office.*"
    })
  if ($actions.Count -lt 36) { throw "Action baseline is below 36: $($actions.Count)" }

  $coldReceipts = Join-Path $artifactDir "cold-start-receipts.jsonl"
  $env:USEFUL_NATIVE_ACTION_RECEIPTS = $coldReceipts
  for ($index = 0; $index -lt $actions.Count; $index++) {
    Start-Action $actions[$index].id
    Wait-ReceiptCount $coldReceipts ($index + 1)
    Assert-OneInstance
    $last = @(Read-Receipts $coldReceipts)[-1]
    if ($last.actionId -ne $actions[$index].id -or $last.route -ne $actions[$index].route -or -not $last.rendered) {
      throw "Cold-start receipt mismatch for $($actions[$index].id)"
    }
    Stop-TestInstances
  }

  $rapidReceipts = Join-Path $artifactDir "rapid-single-instance-receipts.jsonl"
  $env:USEFUL_NATIVE_ACTION_RECEIPTS = $rapidReceipts
  Start-Action $actions[0].id
  Wait-ReceiptCount $rapidReceipts 1
  for ($index = 1; $index -lt $actions.Count; $index++) {
    Start-Action $actions[$index].id
    Start-Sleep -Milliseconds 20
  }
  Wait-ReceiptCount $rapidReceipts $actions.Count
  Start-Sleep -Milliseconds 500
  Assert-OneInstance
  $rapid = @(Read-Receipts $rapidReceipts)
  for ($index = 0; $index -lt $actions.Count; $index++) {
    if ($rapid[$index].actionId -ne $actions[$index].id) {
      throw "Rapid dispatch order mismatch at $index"
    }
  }
  Stop-TestInstances

  $negativeReceipts = Join-Path $artifactDir "negative-receipts.jsonl"
  $env:USEFUL_NATIVE_ACTION_RECEIPTS = $negativeReceipts
  $negativeCases = @(
    [pscustomobject]@{ value = "builtin.utilities.missing"; expected = "builtin.utilities.missing" },
    [pscustomobject]@{ value = ("a" * 512); expected = ("a" * 512) },
    [pscustomobject]@{ value = "builtin.utilities.base64 --file injected"; expected = "builtin.utilities.base64 --file injected" }
  )
  for ($index = 0; $index -lt $negativeCases.Count; $index++) {
    Start-Action $negativeCases[$index].value
    Wait-ReceiptCount $negativeReceipts ($index + 1)
    Assert-OneInstance
    $last = @(Read-Receipts $negativeReceipts)[-1]
    if ($last.actionId -ne $negativeCases[$index].expected -or $last.title -ne "unknown" -or -not $last.rendered) {
      throw "Negative action handling mismatch at $index"
    }
    Stop-TestInstances
  }

  $repeatedReceipts = Join-Path $artifactDir "repeated-argument-receipts.jsonl"
  $env:USEFUL_NATIVE_ACTION_RECEIPTS = $repeatedReceipts
  $repeatArguments = "--open-action $($actions[0].id) --open-action $($actions[3].id)"
  Start-Process -FilePath $testExe -ArgumentList $repeatArguments | Out-Null
  Wait-ReceiptCount $repeatedReceipts 1
  Assert-OneInstance
  $repeat = @(Read-Receipts $repeatedReceipts)[0]
  if ($repeat.actionId -ne $actions[3].id) { throw "Repeated arguments did not resolve to the final value" }
  Stop-TestInstances

  $result = [pscustomobject]@{
    scenario = "native-action-deeplinks"
    commit = $commit
    total = $actions.Count
    coldStartPassed = $actions.Count
    rapidSingleInstancePassed = $actions.Count
    failed = 0
    invalidActionHandled = $true
    overlongActionHandled = $true
    injectedArgumentHandled = $true
    repeatedArgumentPolicy = "last-value-wins"
    chineseAndSpacePath = $true
    artifacts = @(
      "cold-start-receipts.jsonl",
      "rapid-single-instance-receipts.jsonl",
      "negative-receipts.jsonl",
      "repeated-argument-receipts.jsonl"
    )
  }
  ConvertTo-Json -InputObject $result -Depth 8 | Set-Content -LiteralPath (Join-Path $artifactDir "result.json") -Encoding UTF8
  Write-Host "[ OK ] native action deeplinks: $($actions.Count)/$($actions.Count) cold + rapid single-instance"
  Write-Host "Evidence: $artifactDir"
  $exitCode = 0
} catch {
  Write-Host "[FAIL] $($_.Exception.Message)" -ForegroundColor Red
  $exitCode = 1
} finally {
  Stop-TestInstances
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
