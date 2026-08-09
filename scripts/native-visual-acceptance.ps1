# Requires: Windows desktop session and explicit operator presence.
# Does not start Useful/Useful unless -Launch is provided.
# Does not perform security scans, network publishing, or git writes.

[CmdletBinding()]
param(
  [switch]$Launch,
  [string]$ExePath = "",
  [string]$ReportPath = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not $ReportPath) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $ReportPath = Join-Path $env:TEMP "useful-native-visual-acceptance-$stamp.json"
}

$checklist = @(
  @{ id = "launch"; title = "Application launches to Home without crash dialog" },
  @{ id = "theme-light-titlebar"; title = "Light theme: native title bar is light (not black/dark chrome)" },
  @{ id = "theme-dark"; title = "Dark theme applies content + chrome consistently" },
  @{ id = "nav-customize"; title = "Sidebar Customize navigation opens Settings #navigation-layout" },
  @{ id = "nav-hide-reorder"; title = "Can hide non-settings nav items and reorder them" },
  @{ id = "i18n-zh-en"; title = "Switch language zh-CN <-> en-US updates chrome labels" },
  @{ id = "video-open-preview"; title = "Video trim opens common media and shows metadata/preview host state" },
  @{ id = "procmon-aggregate-net"; title = "Process monitor shows interface throughput or explicit capability reason" },
  @{ id = "procmon-no-fake-bytes"; title = "When per-process ETW bytes unavailable, UI does not invent byte rates" },
  @{ id = "settings-data-dirs"; title = "Open data/log directory actions work" }
)

$launched = $false
$process = $null
if ($Launch) {
  if (-not $ExePath) {
    $candidates = @(
      (Join-Path $repoRoot "target/release/Useful.exe"),
      (Join-Path $repoRoot "target/debug/Useful.exe"),
      (Join-Path $repoRoot "apps/useful/src-tauri/target/release/Useful.exe"),
      (Join-Path $repoRoot "apps/useful/src-tauri/target/debug/Useful.exe"),
      (Join-Path $repoRoot "dist-release/Useful.exe")
    )
    $ExePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  }
  if (-not $ExePath -or -not (Test-Path $ExePath)) {
    throw "No Useful.exe found. Build first or pass -ExePath. Refusing to invent a launch path."
  }
  $process = Start-Process -FilePath $ExePath -PassThru
  $launched = $true
  Write-Host "Launched PID=$($process.Id) path=$ExePath"
  Write-Host "Complete the checklist visually, then re-run without -Launch or fill the JSON report."
}

$result = [ordered]@{
  schemaVersion = "useful.native-visual-acceptance.v1"
  ok = $false
  authoritative = $false
  generatedAt = (Get-Date).ToString("o")
  launched = $launched
  exePath = $ExePath
  processId = if ($process) { $process.Id } else { $null }
  items = @()
  operatorNotes = ""
  hardGate = "Operator must mark each item pass/fail. This script never auto-passes GUI checks."
}

foreach ($item in $checklist) {
  $result.items += [ordered]@{
    id = $item.id
    title = $item.title
    status = "pending"
    evidence = ""
  }
}

$json = $result | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($ReportPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Wrote checklist report: $ReportPath"
Write-Host "Fill items[].status with pass|fail|blocked and set ok=true only after all required items pass."
exit 0