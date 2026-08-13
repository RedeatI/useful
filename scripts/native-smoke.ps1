<#
.SYNOPSIS
  Build and run the real Windows Tauri all-tools smoke with machine-readable evidence.
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [string]$ExecutablePath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$artifactDir = Join-Path $RepoRoot "artifacts\native-smoke\$timestamp"
$screenshotsDir = Join-Path $artifactDir "screenshots"
$unicodeFolder = -join @([char]0x5DE5, [char]0x5177, [char]0x7BB1, [char]0x20, [char]0x6D4B, [char]0x8BD5)
$testRoot = Join-Path $env:TEMP "Useful Phase12.1\$unicodeFolder-$timestamp"
. (Join-Path $RepoRoot "scripts\resolve-cargo-target.ps1")
$sourceExe = if ($ExecutablePath) {
  [System.IO.Path]::GetFullPath($ExecutablePath)
} else {
  (Resolve-UsefulReleaseBinaries -RepoRoot $RepoRoot).UsefulExe
}
$testExe = Join-Path $testRoot "Useful.exe"
$mediaInput = Join-Path $testRoot (-join @([char]0x5A92, [char]0x4F53, [char]0x20, [char]0x8F93, [char]0x5165, ".mp4"))
$mediaOutput = "$mediaInput.native-smoke-output.mp4"
$feedbackOutput = "$mediaInput.beta-feedback.zip"
$commit = (& git -C $RepoRoot rev-parse HEAD).Trim()
$processNames = @("Useful", "mpv", "ffmpeg", "ffprobe")
$appProcess = $null
$exitCode = 1

function Get-TestProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
      $processNames -contains [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
    } | ForEach-Object {
      [pscustomobject]@{
        name = $_.Name
        pid = $_.ProcessId
        executablePath = $_.ExecutablePath
      }
    })
}

function Write-JsonFile([string]$Path, $Value) {
  ConvertTo-Json -InputObject $Value -Depth 10 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Copy-DiagnosticEvidence {
  $logDir = Join-Path $testRoot "data\logs"
  $logs = @(Get-ChildItem -LiteralPath $logDir -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc)
  if ($logs.Count -gt 0) {
    $logs | Get-Content | Set-Content -LiteralPath (Join-Path $artifactDir "app.log") -Encoding UTF8
  } elseif (-not (Test-Path -LiteralPath (Join-Path $artifactDir "app.log"))) {
    "native smoke did not produce an app log" | Set-Content -LiteralPath (Join-Path $artifactDir "app.log") -Encoding UTF8
  }
}

function Stop-OwnedChildProcesses([string]$EvidenceName) {
  if (-not $script:appProcess) { return }
  $children = @(Get-CimInstance Win32_Process | Where-Object {
      $_.ParentProcessId -eq $script:appProcess.Id -and
      $processNames -contains [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
    })
  if ($children.Count -eq 0) { return }
  Write-JsonFile (Join-Path $artifactDir $EvidenceName) @($children | ForEach-Object {
      [pscustomobject]@{
        name = $_.Name
        pid = $_.ProcessId
        parentPid = $_.ParentProcessId
        commandLine = $_.CommandLine
      }
    })
  $children | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-NativeSmokeRun {
  $nativeArguments = "--native-smoke `"$artifactDir`" --native-smoke-commit $commit --open-tool builtin.video-trim --file `"$mediaInput`""
  $script:appProcess = Start-Process -FilePath $testExe -ArgumentList $nativeArguments -PassThru
  if (-not $script:appProcess.WaitForExit(180000)) {
    Stop-OwnedChildProcesses "process-timeout-cleanup.json"
    Stop-Process -Id $script:appProcess.Id -Force -ErrorAction SilentlyContinue
    Copy-DiagnosticEvidence
    throw "native smoke timed out after 180 seconds"
  }
  $script:appProcess.Refresh()
  return $script:appProcess.ExitCode
}

try {
  New-Item -ItemType Directory -Force -Path $screenshotsDir | Out-Null
  $processBefore = @(Get-TestProcesses)
  Write-JsonFile (Join-Path $artifactDir "process-before.json") $processBefore

  if (-not $SkipBuild -and -not $ExecutablePath) {
    Push-Location $RepoRoot
    try {
      $previousEap = $ErrorActionPreference
      $previousDevelopmentTrustOptIn = [Environment]::GetEnvironmentVariable(
        "USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST",
        "Process"
      )
      try {
        $ErrorActionPreference = "Continue"
        [Environment]::SetEnvironmentVariable(
          "USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST",
          "1",
          "Process"
        )
        & pnpm --filter "@useful/app" tauri build --no-bundle --features native-test
        $buildCode = $LASTEXITCODE
      } finally {
        [Environment]::SetEnvironmentVariable(
          "USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST",
          $previousDevelopmentTrustOptIn,
          "Process"
        )
        $ErrorActionPreference = $previousEap
      }
      if ($buildCode -ne 0) { throw "Tauri native-test Release build failed: $buildCode" }
    } finally {
      $ErrorActionPreference = "Stop"
      Pop-Location
    }
  }
  if (-not (Test-Path -LiteralPath $sourceExe)) { throw "Release client not found: $sourceExe" }

  New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
  Copy-Item -LiteralPath $sourceExe -Destination $testExe
  New-Item -ItemType File -Force -Path (Join-Path $testRoot "portable.flag") | Out-Null
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & ffmpeg -y -hide_banner -loglevel error -f lavfi -i "testsrc=size=320x180:rate=30" -t 3 -c:v mpeg4 -q:v 4 $mediaInput
  $fixtureCode = $LASTEXITCODE
  $ErrorActionPreference = $previousEap
  if ($fixtureCode -ne 0 -or -not (Test-Path -LiteralPath $mediaInput)) {
    throw "failed to generate native media fixture: $fixtureCode"
  }

  $resultPath = Join-Path $artifactDir "result.json"
  $firstExitCode = Invoke-NativeSmokeRun
  if (-not (Test-Path -LiteralPath $resultPath)) { throw "First run did not produce result.json" }
  $firstResult = Get-Content -Raw -LiteralPath $resultPath -Encoding UTF8 | ConvertFrom-Json
  Move-Item -LiteralPath $resultPath -Destination (Join-Path $artifactDir "result-first-run.json")
  if ($firstExitCode -ne 0 -or [int]$firstResult.failed -ne 0) {
    throw "First native smoke run failed: process=$firstExitCode, checks=$($firstResult.failed)"
  }

  $exitCode = Invoke-NativeSmokeRun
  if (-not (Test-Path -LiteralPath $resultPath)) { throw "Second run did not produce result.json" }
  $result = Get-Content -Raw -LiteralPath $resultPath -Encoding UTF8 | ConvertFrom-Json
  if (-not $result.nativeCapabilities.sqlitePersistedFromPreviousRun) {
    throw "SQLite favorite was not persisted across native app restart"
  }
  if (-not $result.nativeCapabilities.mediaFileOpened -or -not $result.nativeCapabilities.mediaExportPassed) {
    throw "Native media file-open/export did not pass"
  }
  if (-not (Test-Path -LiteralPath $mediaOutput)) { throw "Native media output is missing" }
  $durationText = (& ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $mediaOutput).Trim()
  $duration = 0.0
  if (-not [double]::TryParse($durationText, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$duration) -or $duration -le 0) {
    throw "Native media output duration is invalid: $durationText"
  }
  Copy-Item -LiteralPath $mediaOutput -Destination (Join-Path $artifactDir "native-media-output.mp4")
  if (-not $result.nativeCapabilities.betaFeedbackExportPassed -or -not (Test-Path -LiteralPath $feedbackOutput)) {
    throw "Native Beta feedback package export did not pass"
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $feedbackZip = [System.IO.Compression.ZipFile]::OpenRead($feedbackOutput)
  try {
    $feedbackEntries = @($feedbackZip.Entries | ForEach-Object { $_.FullName })
    if ($feedbackEntries -notcontains "diagnostics.txt" -or $feedbackEntries -notcontains "beta-feedback-template.md") {
      throw "Beta feedback package entries are incomplete"
    }
  } finally {
    $feedbackZip.Dispose()
  }
  Copy-Item -LiteralPath $feedbackOutput -Destination (Join-Path $artifactDir "useful-beta-feedback.zip")

  $databasePath = Join-Path $testRoot "data\useful.db"
  if (-not (Test-Path -LiteralPath $databasePath)) { throw "Portable SQLite database is missing" }
  Copy-Item -LiteralPath $databasePath -Destination (Join-Path $artifactDir "useful.db")

  Copy-DiagnosticEvidence

  $processAfter = @(Get-TestProcesses)
  Write-JsonFile (Join-Path $artifactDir "process-after.json") $processAfter
  $beforePids = @($processBefore | ForEach-Object { $_.pid })
  $leaks = @($processAfter | Where-Object { $beforePids -notcontains $_.pid })
  if ($leaks.Count -gt 0) {
    throw "Native process leak detected: $($leaks.name -join ', ')"
  }
  $summary = @(
    "# Native Tauri Smoke",
    "",
    "- commit: $commit",
    "- version: $($result.version)",
    "- testMode: native-test Release",
    "- windows: $([System.Environment]::OSVersion.VersionString)",
    "- generatedAt: $((Get-Date).ToUniversalTime().ToString('o'))",
    "- total: $($result.total)",
    "- passed: $($result.passed)",
    "- failed: $($result.failed)",
    "- durationMs: $([math]::Round($result.durationMs))",
    "- isolatedDataDir: portable data",
    "- sqliteRestartPersistence: $($result.nativeCapabilities.sqlitePersistedFromPreviousRun)",
    "- clipboardRoundTrip: $($result.nativeCapabilities.clipboardPassed)",
    "- mediaFileOpened: $($result.nativeCapabilities.mediaFileOpened)",
    "- mediaExportPassed: $($result.nativeCapabilities.mediaExportPassed)",
    "- betaFeedbackExportPassed: $($result.nativeCapabilities.betaFeedbackExportPassed)",
    "- mediaOutputDurationSec: $duration",
    "",
    "Screenshots are supplementary evidence and are populated by the GUI evidence stage."
  )
  $summary | Set-Content -LiteralPath (Join-Path $artifactDir "summary.md") -Encoding UTF8

  if ($exitCode -ne 0 -or [int]$result.failed -ne 0) {
    throw "native smoke failed: process=$exitCode, checks=$($result.failed)"
  }
  Write-Host "[ OK ] native Tauri all-tools smoke: $($result.passed)/$($result.total)"
  Write-Host "Evidence: $artifactDir"
  $exitCode = 0
} catch {
  Stop-OwnedChildProcesses "process-failure-cleanup.json"
  Copy-DiagnosticEvidence
  Write-Error $_
  $exitCode = 1
} finally {
  if ($appProcess -and -not $appProcess.HasExited) {
    Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue
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
