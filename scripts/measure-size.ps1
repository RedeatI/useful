# Measure Useful product size drivers and write artifacts/size/size-report.json.
# Does not fail on missing optional artifacts (setup, Full ZIP); hard budget
# enforcement lives in scripts/size-budget.test.mjs when a report is present.

[CmdletBinding()]
param(
    [string]$OutDir,
    [string]$ReportDir
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "resolve-cargo-target.ps1")

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $releaseDir = Join-Path $root "dist-release"
} else {
    $releaseDir = [IO.Path]::GetFullPath($OutDir)
}

if ([string]::IsNullOrWhiteSpace($ReportDir)) {
    $reportRoot = Join-Path $root "artifacts\size"
} else {
    $reportRoot = [IO.Path]::GetFullPath($ReportDir)
}

function Get-FileBytesOrNull([string]$path) {
    $info = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($null -eq $info -or $info.PSIsContainer) { return $null }
    return [int64]$info.Length
}

function Get-DirectoryBytesOrNull([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $sum = (Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum
    if ($null -eq $sum) { return 0 }
    return [int64]$sum
}

function Get-RelativePathCompat([string]$baseDir, [string]$fullPath) {
    $baseFull = [IO.Path]::GetFullPath($baseDir).TrimEnd([char]'\', [char]'/')
    $fileFull = [IO.Path]::GetFullPath($fullPath)
    $prefix = $baseFull + [IO.Path]::DirectorySeparatorChar
    if ($fileFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        return $fileFull.Substring($prefix.Length).Replace('\', '/')
    }
    return [IO.Path]::GetFileName($fullPath)
}

$bins = Resolve-UsefulReleaseBinaries -RepoRoot $root
$frontendDist = Join-Path $root "apps\useful\dist"
$frontendBytes = Get-DirectoryBytesOrNull $frontendDist
$largestAssets = @()
if (Test-Path -LiteralPath $frontendDist) {
    $largestAssets = @(
        Get-ChildItem -LiteralPath $frontendDist -Recurse -File -Force -ErrorAction SilentlyContinue |
            Sort-Object Length -Descending |
            Select-Object -First 15 |
            ForEach-Object {
                [ordered]@{
                    path = Get-RelativePathCompat $frontendDist $_.FullName
                    bytes = [int64]$_.Length
                }
            }
    )
}

$entryJs = $null
$agentChunk = $null
foreach ($asset in $largestAssets) {
    $name = [string]$asset.path
    if ($null -eq $entryJs -and ($name -match '(^|/)index-.*\.js$' -or $name -match '(^|/)main-.*\.js$')) {
        $entryJs = [int64]$asset.bytes
    }
    if ($null -eq $agentChunk -and ($name -match 'Agent|agent-profile|agentProfile')) {
        $agentChunk = [int64]$asset.bytes
    }
}
# Fallback: largest JS under assets if heuristics miss.
if ($null -eq $entryJs -and $largestAssets.Count -gt 0) {
    $jsAssets = @($largestAssets | Where-Object { $_.path -like '*.js' })
    if ($jsAssets.Count -gt 0) { $entryJs = [int64]$jsAssets[0].bytes }
}

$mediaComponents = @()
$binaryRoot = Join-Path $root "binaries"
foreach ($name in @("ffmpeg.exe", "ffprobe.exe", "mpv.exe")) {
    $path = Join-Path $binaryRoot $name
    $bytes = Get-FileBytesOrNull $path
    if ($null -ne $bytes) {
        $mediaComponents += [ordered]@{ name = $name; bytes = $bytes; path = "binaries/$name" }
    }
}

$portableLiteDir = Join-Path $releaseDir "Useful-Portable-Lite-x64"
$portableFullDir = Join-Path $releaseDir "Useful-Portable-Full-x64"
$portableLiteZip = Join-Path $releaseDir "Useful-Portable-Lite-x64.zip"
$portableFullZip = Join-Path $releaseDir "Useful-Portable-Full-x64.zip"

$setupCandidates = @(
    Get-ChildItem -LiteralPath $releaseDir -File -Filter "*setup*lite*.exe" -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath $releaseDir -File -Filter "*setup*.exe" -ErrorAction SilentlyContinue
) | Where-Object { $null -ne $_ } | Select-Object -First 1
$setupLiteBytes = if ($setupCandidates) { [int64]$setupCandidates.Length } else { $null }

$commit = $null
try {
    $commit = (& git -C $root rev-parse HEAD).Trim()
} catch {
    $commit = $null
}

$report = [ordered]@{
    schemaVersion = "useful.size-report.v1"
    measuredAtUtc = [DateTime]::UtcNow.ToString("o")
    commit = $commit
    cargoTargetDirectory = $bins.TargetDirectory
    usefulExeBytes = Get-FileBytesOrNull $bins.UsefulExe
    usefulExePath = $bins.UsefulExe
    bootstrapExeBytes = Get-FileBytesOrNull $bins.BootstrapExe
    bootstrapExePath = $bins.BootstrapExe
    frontendDistBytes = $frontendBytes
    frontendLargestAssets = $largestAssets
    entryJsBytes = $entryJs
    agentChunkBytes = $agentChunk
    portableLiteRawBytes = Get-DirectoryBytesOrNull $portableLiteDir
    portableLiteZipBytes = Get-FileBytesOrNull $portableLiteZip
    setupLiteBytes = $setupLiteBytes
    portableFullRawBytes = Get-DirectoryBytesOrNull $portableFullDir
    portableFullZipBytes = Get-FileBytesOrNull $portableFullZip
    mediaComponents = $mediaComponents
    releaseDirectory = $releaseDir
}

if (-not (Test-Path -LiteralPath $reportRoot)) {
    New-Item -ItemType Directory -Path $reportRoot | Out-Null
}
$reportPath = Join-Path $reportRoot "size-report.json"
$json = ($report | ConvertTo-Json -Depth 8)
[IO.File]::WriteAllText($reportPath, $json + "`n", [Text.UTF8Encoding]::new($false))

# Human-readable summary on stdout
function Format-Mb($bytes) {
    if ($null -eq $bytes) { return "n/a" }
    return ("{0:N2} MB" -f ([double]$bytes / 1MB))
}

Write-Host "Size report: $reportPath"
Write-Host ("  Useful.exe:          {0}" -f (Format-Mb $report.usefulExeBytes))
Write-Host ("  useful-bootstrap:    {0}" -f (Format-Mb $report.bootstrapExeBytes))
Write-Host ("  frontend dist:       {0}" -f (Format-Mb $report.frontendDistBytes))
Write-Host ("  Portable Lite ZIP:   {0}" -f (Format-Mb $report.portableLiteZipBytes))
Write-Host ("  Portable Full ZIP:   {0}" -f (Format-Mb $report.portableFullZipBytes))
Write-Host ("  setup Lite:          {0}" -f (Format-Mb $report.setupLiteBytes))
Write-Host ("  cargo target_dir:    {0}" -f $bins.TargetDirectory)
