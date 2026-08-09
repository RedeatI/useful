# Build Standard (default) and Core (--no-default-features + custom-protocol) release
# binaries, compare Useful.exe sizes, write artifacts/size/edition-size.json.

[CmdletBinding()]
param(
    [string]$ReportDir
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "resolve-cargo-target.ps1")

if ([string]::IsNullOrWhiteSpace($ReportDir)) {
    $reportRoot = Join-Path $root "artifacts\size"
} else {
    $reportRoot = [IO.Path]::GetFullPath($ReportDir)
}
if (-not (Test-Path -LiteralPath $reportRoot)) {
    New-Item -ItemType Directory -Path $reportRoot | Out-Null
}

$bins = Resolve-UsefulReleaseBinaries -RepoRoot $root
$compareDir = Join-Path $reportRoot "edition-binaries"
if (Test-Path -LiteralPath $compareDir) {
    [IO.Directory]::Delete($compareDir, $true)
}
New-Item -ItemType Directory -Path $compareDir | Out-Null

$prevTrust = $env:USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST
$env:USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST = "1"

function Invoke-EditionBuild([string]$Label, [string[]]$CargoArgs, [string]$OutName) {
    Write-Host "==== Building $Label ====" -ForegroundColor Cyan
    Push-Location $root
    try {
        & cargo build --release --locked @CargoArgs
        if ($LASTEXITCODE -ne 0) { throw "cargo build failed for $Label (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
    $source = (Resolve-UsefulReleaseBinaries -RepoRoot $root).UsefulExe
    if (-not (Test-Path -LiteralPath $source)) { throw "missing $source after $Label build" }
    $dest = Join-Path $compareDir $OutName
    Copy-Item -LiteralPath $source -Destination $dest
    $len = (Get-Item -LiteralPath $dest).Length
    Write-Host ("  {0}: {1:N2} MB ({2} bytes)" -f $Label, ($len / 1MB), $len)
    return [pscustomobject]@{ label = $Label; path = $dest; bytes = [int64]$len }
}

try {
    $standard = Invoke-EditionBuild "standard" @("-p", "useful-app") "Useful-standard.exe"
    $core = Invoke-EditionBuild "core" @(
        "-p", "useful-app",
        "--no-default-features",
        "--features", "custom-protocol"
    ) "Useful-core.exe"
} finally {
    if ($null -eq $prevTrust) {
        Remove-Item Env:USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST -ErrorAction SilentlyContinue
    } else {
        $env:USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST = $prevTrust
    }
}

$delta = [int64]$standard.bytes - [int64]$core.bytes
$pct = if ($standard.bytes -gt 0) { [math]::Round(100.0 * $delta / $standard.bytes, 2) } else { 0 }

$commit = $null
try { $commit = (& git -C $root rev-parse HEAD).Trim() } catch { $commit = $null }

$report = [ordered]@{
    schemaVersion = "useful.edition-size.v1"
    measuredAtUtc = [DateTime]::UtcNow.ToString("o")
    commit = $commit
    cargoTargetDirectory = $bins.TargetDirectory
    standardExeBytes = [int64]$standard.bytes
    coreExeBytes = [int64]$core.bytes
    deltaBytes = $delta
    deltaPercent = $pct
    coreMeets1_5MbGate = ($delta -ge (1536 * 1024))
    coreMeets15PercentGate = ($pct -ge 15)
    notes = @(
        "Standard = default features (custom-protocol + standard = procmon + media).",
        "Core = --no-default-features --features custom-protocol (stubs only for procmon/media commands).",
        "Public product remains Standard Lite/Full; Core is internal unless product gates pass."
    )
}

$reportPath = Join-Path $reportRoot "edition-size.json"
[IO.File]::WriteAllText($reportPath, (($report | ConvertTo-Json -Depth 6) + "`n"), [Text.UTF8Encoding]::new($false))
Write-Host "Edition size report: $reportPath"
Write-Host ("  Standard: {0:N2} MB" -f ($standard.bytes / 1MB))
Write-Host ("  Core:     {0:N2} MB" -f ($core.bytes / 1MB))
Write-Host ("  Delta:    {0:N2} MB ({1}%)" -f ($delta / 1MB), $pct)
Write-Host ("  Gate 1.5MB: {0}  |  Gate 15%: {1}" -f $report.coreMeets1_5MbGate, $report.coreMeets15PercentGate)
