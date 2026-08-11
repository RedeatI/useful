# Merge native/archive measurements into the manifest-backed frontend report.
# The report remains under artifacts/size and is never a release deliverable.

[CmdletBinding()]
param(
    [string]$OutDir,
    [string]$ExpectedCommit,
    [string]$Target
)

$ErrorActionPreference = "Stop"
$maximumMetricBytes = [int64]1000000000
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "resolve-cargo-target.ps1")

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $releaseDir = Join-Path $root "dist-release"
} else {
    $releaseDir = [IO.Path]::GetFullPath($OutDir)
}

$reportRoot = Join-Path $root "artifacts\size"
$reportPath = Join-Path $reportRoot "size-report.json"

function Assert-NoReparsePath([string]$candidate) {
    $full = [IO.Path]::GetFullPath($candidate)
    $pathRoot = [IO.Path]::GetPathRoot($full)
    $segments = @($full.Substring($pathRoot.Length) -split '[\\/]' | Where-Object { $_ -ne "" })
    $cursor = $pathRoot
    for ($index = 0; $index -lt $segments.Count; $index++) {
        $cursor = Join-Path $cursor $segments[$index]
        $info = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($null -eq $info) { throw "Path component is missing: $cursor" }
        if ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Path component is a symlink/junction/reparse point: $cursor"
        }
        if ($index -lt $segments.Count - 1 -and -not $info.PSIsContainer) {
            throw "Intermediate path component is not a directory: $cursor"
        }
    }
}

function Get-RepoRelativePath([string]$path, [string]$label) {
    $rootFull = [IO.Path]::GetFullPath($root).TrimEnd([char]'\', [char]'/')
    $fileFull = [IO.Path]::GetFullPath($path)
    $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
    if (-not $fileFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$label must stay inside the repository: $fileFull"
    }
    $relative = $fileFull.Substring($prefix.Length).Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative.StartsWith('../') -or $relative.Contains('/../')) {
        throw "$label repository-relative path is invalid: $relative"
    }
    return $relative
}

function Get-ArtifactEvidenceOrNull([string]$path, [string]$label) {
    $info = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($null -eq $info) { return $null }
    Assert-NoReparsePath $info.FullName
    if ($info.PSIsContainer -or $info.Length -le 0) { throw "$label must be a non-empty regular file: $path" }
    if ([int64]$info.Length -gt $maximumMetricBytes) { throw "$label exceeds $maximumMetricBytes bytes: $path" }
    $hash = Get-FileHash -LiteralPath $info.FullName -Algorithm SHA256
    return [ordered]@{
        path = Get-RepoRelativePath $info.FullName $label
        bytes = [int64]$info.Length
        sha256 = $hash.Hash.ToLowerInvariant()
    }
}

function Resolve-MeasurementBinaries([string]$targetTriple) {
    $targetDirectory = Get-UsefulCargoTargetDirectory -RepoRoot $root
    if ([string]::IsNullOrWhiteSpace($targetTriple)) {
        $profileDirectory = Join-Path $targetDirectory "release"
    } else {
        if ($targetTriple -cnotmatch '^[A-Za-z0-9_.-]+$') { throw "Invalid Cargo target triple: $targetTriple" }
        $profileDirectory = Join-Path (Join-Path $targetDirectory $targetTriple) "release"
    }
    return [pscustomobject]@{
        TargetDirectory = $targetDirectory
        ProfileDirectory = $profileDirectory
        UsefulExe = Join-Path $profileDirectory "Useful.exe"
        BootstrapExe = Join-Path $profileDirectory "useful-bootstrap.exe"
    }
}

function Get-ExactReleaseArtifactOrNull(
    [string]$directory,
    [string]$label,
    [string]$exactName
) {
    $directoryInfo = Get-Item -LiteralPath $directory -Force -ErrorAction SilentlyContinue
    if ($null -eq $directoryInfo) { return $null }
    Assert-NoReparsePath $directoryInfo.FullName
    if (-not $directoryInfo.PSIsContainer) { throw "Release output must be a directory: $directory" }
    return Get-ArtifactEvidenceOrNull (Join-Path $directory $exactName) $label
}

$actualCommit = (& git -C $root rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw "Could not read Git HEAD" }
if ($actualCommit -cnotmatch '^[0-9a-f]{40}$') { throw "Git HEAD must be lowercase 40-hex: $actualCommit" }
if ([string]::IsNullOrWhiteSpace($ExpectedCommit)) { $ExpectedCommit = $env:USEFUL_SIZE_EXPECTED_COMMIT }
if ([string]::IsNullOrWhiteSpace($ExpectedCommit)) { $ExpectedCommit = $actualCommit }
if ($ExpectedCommit -cnotmatch '^[0-9a-f]{40}$') { throw "ExpectedCommit must be lowercase 40-hex" }
if ($ExpectedCommit -cne $actualCommit) { throw "Checkout HEAD $actualCommit does not match expected commit $ExpectedCommit" }

Assert-NoReparsePath $reportPath
$reportInfo = Get-Item -LiteralPath $reportPath -Force
if ($reportInfo.PSIsContainer -or $reportInfo.Length -le 0 -or [int64]$reportInfo.Length -gt $maximumMetricBytes) {
    throw "Frontend size report must be a regular file between 1 and $maximumMetricBytes bytes: $reportPath"
}
$reportText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($reportPath))
$report = $reportText | ConvertFrom-Json
if ($report.schemaVersion -cne "useful.size-report.v2") { throw "Expected useful.size-report.v2 before native measurement" }
if ([string]$report.commit -cne $actualCommit) { throw "Frontend size report commit does not match Git HEAD" }

$expectedReportFields = [string[]]@(
    "schemaVersion", "commit", "frontendDistPath", "frontendEntrySource", "frontendEntryFile",
    "frontendInitialJsFiles", "agentProfileSource", "agentProfileChunkFile", "officeWorkerAsset",
    "frontendFiles", "releaseArtifacts", "usefulExeBytes", "bootstrapExeBytes", "frontendAppBytes", "officeWorkerBytes",
    "frontendDistBytes", "initialJsBytes", "agentProfileChunkBytes", "portableLiteZipBytes",
    "setupLiteBytes", "portableFullZipBytes"
)
$actualReportFields = [string[]]@($report.PSObject.Properties.Name)
[Array]::Sort($expectedReportFields, [StringComparer]::Ordinal)
[Array]::Sort($actualReportFields, [StringComparer]::Ordinal)
if (($expectedReportFields -join "`n") -cne ($actualReportFields -join "`n")) {
    throw "Frontend size report field set is not closed"
}

$bins = Resolve-MeasurementBinaries $Target
$package = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes((Join-Path $root "package.json"))) | ConvertFrom-Json
$version = [string]$package.version
if ($version -cnotmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') { throw "package.json version is invalid: $version" }

$usefulEvidence = Get-ArtifactEvidenceOrNull $bins.UsefulExe "Useful executable"
$bootstrapEvidence = Get-ArtifactEvidenceOrNull $bins.BootstrapExe "Bootstrap executable"
if ([string]::IsNullOrWhiteSpace($Target)) {
    $portableLiteEvidence = Get-ExactReleaseArtifactOrNull $releaseDir "Portable Lite ZIP" "Useful-Portable-Lite-x64.zip"
    $setupLiteEvidence = $null
    $portableFullEvidence = $null
} else {
    $portableLiteEvidence = Get-ExactReleaseArtifactOrNull $releaseDir "Portable Lite ZIP" "Useful-$version-windows-x64-portable-lite.zip"
    $setupLiteEvidence = Get-ExactReleaseArtifactOrNull $releaseDir "Setup Lite" "Useful-$version-windows-x64-setup-lite.exe"
    $portableFullEvidence = Get-ExactReleaseArtifactOrNull $releaseDir "Portable Full ZIP" "Useful-$version-windows-x64-portable-full.zip"
}

$report.releaseArtifacts.usefulExe = $usefulEvidence
$report.releaseArtifacts.bootstrapExe = $bootstrapEvidence
$report.releaseArtifacts.portableLiteZip = $portableLiteEvidence
$report.releaseArtifacts.setupLite = $setupLiteEvidence
$report.releaseArtifacts.portableFullZip = $portableFullEvidence
$report.usefulExeBytes = if ($null -eq $usefulEvidence) { $null } else { [int64]$usefulEvidence.bytes }
$report.bootstrapExeBytes = if ($null -eq $bootstrapEvidence) { $null } else { [int64]$bootstrapEvidence.bytes }
$report.portableLiteZipBytes = if ($null -eq $portableLiteEvidence) { $null } else { [int64]$portableLiteEvidence.bytes }
$report.setupLiteBytes = if ($null -eq $setupLiteEvidence) { $null } else { [int64]$setupLiteEvidence.bytes }
$report.portableFullZipBytes = if ($null -eq $portableFullEvidence) { $null } else { [int64]$portableFullEvidence.bytes }

$json = $report | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText($reportPath, $json + "`n", [Text.UTF8Encoding]::new($false))

function Format-Mb($bytes) {
    if ($null -eq $bytes) { return "n/a" }
    return ("{0:N2} MB" -f ([double]$bytes / 1MB))
}

Write-Host "Size report: $reportPath"
Write-Host ("  commit:              {0}" -f $report.commit)
Write-Host ("  Useful.exe:          {0}" -f (Format-Mb $report.usefulExeBytes))
Write-Host ("  useful-bootstrap:    {0}" -f (Format-Mb $report.bootstrapExeBytes))
Write-Host ("  frontend app:        {0}" -f (Format-Mb $report.frontendAppBytes))
Write-Host ("  office worker:       {0}" -f (Format-Mb $report.officeWorkerBytes))
Write-Host ("  frontend dist:       {0}" -f (Format-Mb $report.frontendDistBytes))
Write-Host ("  initial JS closure:  {0}" -f (Format-Mb $report.initialJsBytes))
Write-Host ("  AgentProfile chunk:  {0}" -f (Format-Mb $report.agentProfileChunkBytes))
Write-Host ("  Portable Lite ZIP:   {0}" -f (Format-Mb $report.portableLiteZipBytes))
Write-Host ("  Portable Full ZIP:   {0}" -f (Format-Mb $report.portableFullZipBytes))
Write-Host ("  setup Lite:          {0}" -f (Format-Mb $report.setupLiteBytes))
Write-Host ("  cargo target_dir:    {0}" -f $bins.TargetDirectory)
