# Configure Useful developer build cache layout for the current PowerShell session.
# Machine-local paths are NOT written into the repo .cargo/config.toml.
#
# Modes:
#   Interactive — normal debugging (incremental on, debug info kept)
#   Compact     — disk-constrained / multi-worktree (no incremental, debug=0 profile, sccache on)
#   CI          — reproducible CI-like session (no incremental, sccache on)
#
# Usage:
#   . .\scripts\dev-cache.ps1 -Mode Compact
#   . .\scripts\dev-cache.ps1 -Mode Interactive -CacheRoot D:\BuildCache\Useful
#   cargo build --release -p useful-app -p useful-bootstrap

[CmdletBinding()]
param(
    [ValidateSet("Interactive", "Compact", "CI")]
    [string]$Mode = "Interactive",

    [string]$CacheRoot,

    [string]$WorktreeKey,

    [switch]$DisableSccache
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if ([string]::IsNullOrWhiteSpace($CacheRoot)) {
    $drive = [IO.Path]::GetPathRoot($repoRoot).TrimEnd('\')
    $CacheRoot = Join-Path $drive "BuildCache\Useful"
}

if ([string]::IsNullOrWhiteSpace($WorktreeKey)) {
    $branch = ""
    try {
        $branch = (& git -C $repoRoot rev-parse --abbrev-ref HEAD 2>$null).Trim()
    } catch {
        $branch = ""
    }
    if ([string]::IsNullOrWhiteSpace($branch) -or $branch -eq "HEAD") {
        $branch = "detached"
    }
    $safeBranch = ($branch -replace '[^A-Za-z0-9._-]+', '-')
    $leaf = Split-Path $repoRoot -Leaf
    $WorktreeKey = "$leaf-$safeBranch"
}

$targetDir = Join-Path $CacheRoot "target\$WorktreeKey"
$sccacheDir = Join-Path $CacheRoot "sccache"

foreach ($dir in @($targetDir, $sccacheDir)) {
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
}

$env:CARGO_TARGET_DIR = $targetDir
$env:SCCACHE_DIR = $sccacheDir
$env:SCCACHE_CACHE_SIZE = "10G"

$useSccache = -not $DisableSccache
if ($Mode -eq "Interactive" -and -not $PSBoundParameters.ContainsKey("DisableSccache")) {
    # Interactive: sccache optional; enable only when already on PATH unless user forces via not disabling.
    $useSccache = $null -ne (Get-Command sccache -ErrorAction SilentlyContinue)
}

if ($Mode -in @("Compact", "CI")) {
    $useSccache = -not $DisableSccache
}

if ($useSccache -and (Get-Command sccache -ErrorAction SilentlyContinue)) {
    $env:RUSTC_WRAPPER = "sccache"
} else {
    if ($env:RUSTC_WRAPPER -eq "sccache") {
        Remove-Item Env:RUSTC_WRAPPER -ErrorAction SilentlyContinue
    }
    if ($Mode -in @("Compact", "CI") -and -not $DisableSccache) {
        Write-Warning "sccache not found on PATH; continuing without RUSTC_WRAPPER"
    }
}

Write-Host "Useful dev-cache mode: $Mode"
Write-Host "  CARGO_TARGET_DIR     = $env:CARGO_TARGET_DIR"
Write-Host "  SCCACHE_DIR          = $env:SCCACHE_DIR"
Write-Host "  SCCACHE_CACHE_SIZE   = $env:SCCACHE_CACHE_SIZE"
Write-Host "  RUSTC_WRAPPER        = $(if ($env:RUSTC_WRAPPER) { $env:RUSTC_WRAPPER } else { '(none)' })"
if ($Mode -eq "Compact") {
    Write-Host "  Tip: cargo build --profile dev-compact"
    Write-Host "       cargo test  --profile test-compact --workspace"
}
if ($Mode -eq "CI") {
    Write-Host "  Tip: cargo build --release --locked -p useful-app -p useful-bootstrap"
}
Write-Host "  Prefer host builds without --target x86_64-pc-windows-msvc on native Windows."
