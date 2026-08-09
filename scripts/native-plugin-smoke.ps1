<#
.SYNOPSIS
  Build three representative plugins and verify install/run/palette/shortcut/uninstall in real Tauri.
#>
[CmdletBinding()]
param(
  [switch]$SkipTauriBuild,
  [string]$ExecutablePath,
  [string[]]$PackagePaths
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$artifactDir = Join-Path $RepoRoot "artifacts\plugin-lifecycle\$timestamp"
$buildDir = Join-Path $artifactDir "build"
$packageDir = Join-Path $artifactDir "packages"
$unicodeFolder = -join @([char]0x63D2, [char]0x4EF6, [char]0x20, [char]0x6D4B, [char]0x8BD5)
$testRoot = Join-Path $env:TEMP "Useful Phase12.1\$unicodeFolder-$timestamp"
$desktopDir = Join-Path $testRoot (-join @([char]0x4E2D, [char]0x6587, [char]0x20, [char]0x684C, [char]0x9762))
. (Join-Path $RepoRoot "scripts\resolve-cargo-target.ps1")
$sourceExe = if ($ExecutablePath) { [System.IO.Path]::GetFullPath($ExecutablePath) } else { (Resolve-UsefulReleaseBinaries -RepoRoot $RepoRoot).UsefulExe }
$testExe = Join-Path $testRoot "Useful.exe"
$commit = (& git -C $RepoRoot rev-parse HEAD).Trim()
$appProcess = $null
$exitCode = 1

function Quote-NativeArg([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Get-TestProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
      @("Useful", "mpv", "ffmpeg", "ffprobe") -contains [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
    } | ForEach-Object {
      [pscustomobject]@{ name = $_.Name; pid = $_.ProcessId; executablePath = $_.ExecutablePath }
    })
}

function Write-JsonFile([string]$Path, $Value) {
  ConvertTo-Json -InputObject $Value -Depth 10 | Set-Content -LiteralPath $Path -Encoding UTF8
}

try {
  New-Item -ItemType Directory -Force -Path $buildDir, $packageDir, $desktopDir | Out-Null
  $processBefore = @(Get-TestProcesses)
  Write-JsonFile (Join-Path $artifactDir "process-before.json") $processBefore

  if ($PackagePaths -and $PackagePaths.Count -gt 0) {
    foreach ($packagePath in $PackagePaths) {
      $resolvedPackage = [IO.Path]::GetFullPath($packagePath)
      if (-not (Test-Path -LiteralPath $resolvedPackage)) { throw "plugin package not found: $resolvedPackage" }
      Copy-Item -LiteralPath $resolvedPackage -Destination $packageDir
    }
  } else {
    $examples = @(
      @{ Name = "base64"; Source = "examples\base64-tool" },
      @{ Name = "file-hash"; Source = "examples\file-hash-tool" },
      @{ Name = "qr-code"; Source = "examples\qr-code-tool" }
    )
    foreach ($example in $examples) {
      $source = Join-Path $RepoRoot $example.Source
      $output = Join-Path $buildDir $example.Name
      & node (Join-Path $RepoRoot "scripts\build-plugin-example.mjs") $source $output
      if ($LASTEXITCODE -ne 0) { throw "plugin build failed: $($example.Name)" }
      & node (Join-Path $RepoRoot "packages\useful-cli\bin\useful.mjs") validate $output
      if ($LASTEXITCODE -ne 0) { throw "plugin validation failed: $($example.Name)" }
      & node (Join-Path $RepoRoot "packages\useful-cli\bin\useful.mjs") pack $output $packageDir
      if ($LASTEXITCODE -ne 0) { throw "plugin pack failed: $($example.Name)" }
    }
  }

  if (-not $SkipTauriBuild) {
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

  New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
  Copy-Item -LiteralPath $sourceExe -Destination $testExe
  New-Item -ItemType File -Force -Path (Join-Path $testRoot "portable.flag") | Out-Null
  $packages = @(Get-ChildItem -LiteralPath $packageDir -File -Filter "*.useful" | Sort-Object Name)
  $expectedCount = if ($PackagePaths -and $PackagePaths.Count -gt 0) { $PackagePaths.Count } else { 3 }
  if ($packages.Count -ne $expectedCount) { throw "expected $expectedCount plugin packages, got $($packages.Count)" }

  $args = @("--native-plugin-smoke", (Quote-NativeArg $artifactDir), "--native-smoke-commit", $commit)
  foreach ($package in $packages) {
    $args += "--plugin-package"
    $args += Quote-NativeArg $package.FullName
  }
  $env:USEFUL_NATIVE_TEST_DESKTOP = $desktopDir
  $appProcess = Start-Process -FilePath $testExe -ArgumentList ($args -join " ") -PassThru
  if (-not $appProcess.WaitForExit(150000)) {
    Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue
    throw "native plugin smoke timed out after 150 seconds"
  }
  $appProcess.Refresh()
  $resultPath = Join-Path $artifactDir "result.json"
  if (-not (Test-Path -LiteralPath $resultPath)) { throw "native plugin smoke did not produce result.json" }
  $result = Get-Content -Raw -LiteralPath $resultPath -Encoding UTF8 | ConvertFrom-Json

  $remainingLinks = @(Get-ChildItem -LiteralPath $desktopDir -File -Filter "*.lnk" -ErrorAction SilentlyContinue)
  if ($remainingLinks.Count -ne 0) { throw "plugin shortcut cleanup left $($remainingLinks.Count) .lnk files" }
  $databasePath = Join-Path $testRoot "data\useful.db"
  if (Test-Path -LiteralPath $databasePath) {
    Copy-Item -LiteralPath $databasePath -Destination (Join-Path $artifactDir "useful.db")
  }
  $logDir = Join-Path $testRoot "data\logs"
  $logs = @(Get-ChildItem -LiteralPath $logDir -File -ErrorAction SilentlyContinue)
  if ($logs.Count -gt 0) { $logs | Get-Content | Set-Content -LiteralPath (Join-Path $artifactDir "app.log") -Encoding UTF8 }

  $processAfter = @(Get-TestProcesses)
  Write-JsonFile (Join-Path $artifactDir "process-after.json") $processAfter
  $beforePids = @($processBefore | ForEach-Object { $_.pid })
  $leaks = @($processAfter | Where-Object { $beforePids -notcontains $_.pid })
  if ($leaks.Count -gt 0) { throw "plugin smoke process leak: $($leaks.name -join ', ')" }

  if ($appProcess.ExitCode -ne 0 -or [int]$result.failed -ne 0) {
    throw "native plugin smoke failed: process=$($appProcess.ExitCode), checks=$($result.failed)"
  }
  @(
    "# Native Plugin Lifecycle Smoke", "", "- commit: $commit", "- plugins: $($result.total)",
    "- passed: $($result.passed)", "- failed: $($result.failed)",
    "- nativeTauri: true", "- isolatedPortableData: true", "- shortcutCleanup: true"
  ) | Set-Content -LiteralPath (Join-Path $artifactDir "summary.md") -Encoding UTF8
  Write-Host "[ OK ] native plugin lifecycle: $($result.passed)/$($result.total)"
  Write-Host "Evidence: $artifactDir"
  $exitCode = 0
} catch {
  Write-Error $_
  $exitCode = 1
} finally {
  Remove-Item Env:USEFUL_NATIVE_TEST_DESKTOP -ErrorAction SilentlyContinue
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
