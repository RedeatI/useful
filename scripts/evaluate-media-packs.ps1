# Measure media-pack v2 candidates without retaining duplicate large ZIP artifacts.
# Production media-runtimes.lock.json and binaries/ are never modified.

[CmdletBinding()]
param(
    [string]$BinariesDir,
    [string]$ReportDir
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($BinariesDir)) { $BinariesDir = Join-Path $root "binaries" }
if ([string]::IsNullOrWhiteSpace($ReportDir)) { $ReportDir = Join-Path $root "artifacts\size" }
$BinariesDir = [IO.Path]::GetFullPath($BinariesDir)
$ReportDir = [IO.Path]::GetFullPath($ReportDir)
$productionLock = Join-Path $PSScriptRoot "media-runtimes.lock.json"
$candidateLock = Join-Path $PSScriptRoot "media-runtimes.v2.candidate.lock.json"

function Assert-OrdinaryFile([string]$file, [string]$label) {
    $info = Get-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    if ($null -eq $info -or $info.PSIsContainer -or $info.Length -le 0 -or
        ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "$label must be a non-empty ordinary file"
    }
}

Assert-OrdinaryFile $productionLock "production media lock"
Assert-OrdinaryFile $candidateLock "v2 candidate media lock"
foreach ($name in @("ffmpeg.exe", "ffprobe.exe", "mpv.exe")) {
    Assert-OrdinaryFile (Join-Path $BinariesDir $name) "media input $name"
}
if (-not (Test-Path -LiteralPath $ReportDir)) { New-Item -ItemType Directory -Path $ReportDir | Out-Null }
$reportInfo = Get-Item -LiteralPath $ReportDir -Force
if (-not $reportInfo.PSIsContainer -or ($reportInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "ReportDir must be an ordinary directory"
}
$reportPath = Join-Path $ReportDir "media-pack-v2-eval.json"
if (Test-Path -LiteralPath $reportPath) { throw "Refusing to overwrite existing media-pack evaluation: $reportPath" }

$productionHashBefore = (Get-FileHash -LiteralPath $productionLock -Algorithm SHA256).Hash.ToLowerInvariant()
$work = Join-Path $ReportDir (".media-pack-eval-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $work | Out-Null
$input = Join-Path $work "input"
$output = Join-Path $work "output"
New-Item -ItemType Directory -Path $input,$output | Out-Null

try {
    $checksumLines = @()
    foreach ($name in @("ffmpeg.exe", "ffprobe.exe", "mpv.exe")) {
        $source = Join-Path $BinariesDir $name
        $destination = Join-Path $input $name
        New-Item -ItemType HardLink -Path $destination -Target $source | Out-Null
        $checksumLines += "$((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant())  $name"
    }
    [IO.File]::WriteAllText(
        (Join-Path $input "CHECKSUMS.txt"),
        (($checksumLines -join "`n") + "`n"),
        [Text.Encoding]::ASCII
    )
    & (Join-Path $PSScriptRoot "package-media-packs.ps1") `
        -LockPath $candidateLock -BinariesDir $input -OutDir $output | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Media-pack candidate packaging failed" }

    $preview = Get-Item -LiteralPath (Join-Path $output "Useful-Media-Pack-preview-windows-x64-unsigned-candidate.zip")
    $transcode = Get-Item -LiteralPath (Join-Path $output "Useful-Media-Pack-transcode-windows-x64-unsigned-candidate.zip")
    $total = [int64]($preview.Length + $transcode.Length)
    $target = [int64](100MB)
    $productionHashAfter = (Get-FileHash -LiteralPath $productionLock -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($productionHashAfter -cne $productionHashBefore) { throw "Production media lock changed during pack evaluation" }

    $report = [ordered]@{
        schemaVersion = "useful.media-pack-evaluation.v1"
        measuredAtUtc = [DateTime]::UtcNow.ToString("o")
        candidateLock = "scripts/media-runtimes.v2.candidate.lock.json"
        productionLockUnchanged = $true
        distributionStatus = "unsigned-candidate"
        previewPackBytes = [int64]$preview.Length
        transcodePackBytes = [int64]$transcode.Length
        allPacksBytes = $total
        allPacksTargetBytes = $target
        allPacksMeetTarget = ($total -le $target)
        initialDownloadRemainsLite = $true
        decision = if ($total -le $target) {
            "CANDIDATE_SPLIT_MEETS_SIZE_TARGET_BUT_SIGNATURE_AND_GPL_GATES_REMAIN"
        } else {
            "CANDIDATE_SPLIT_ONLY_TOTAL_TARGET_NOT_MET"
        }
        notes = @(
            "Pack splitting reduces initial download but not total installed bytes.",
            "The v2 candidate preserves full_build and AV1 software encoding.",
            "Public distribution and in-app install remain blocked on MediaPack signatures and GPL corresponding-source evidence."
        )
    }
    [IO.File]::WriteAllText(
        $reportPath,
        (($report | ConvertTo-Json -Depth 8) + "`n"),
        (New-Object Text.UTF8Encoding($false))
    )
    Write-Host "Media-pack v2 evaluation: $reportPath"
    Write-Host ("  preview:   {0:N1} MB" -f ($preview.Length / 1MB))
    Write-Host ("  transcode: {0:N1} MB" -f ($transcode.Length / 1MB))
    Write-Host ("  total:     {0:N1} MB (target <= 100 MB: {1})" -f ($total / 1MB), ($total -le $target))
} finally {
    if (Test-Path -LiteralPath $work) { [IO.Directory]::Delete($work, $true) }
}
