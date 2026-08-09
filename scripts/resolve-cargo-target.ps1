# Shared helper: resolve Cargo target_directory and release binaries.
# Respects CARGO_TARGET_DIR / cargo config; do not hardcode repo-local target\.
# Dot-source from other scripts:
#   . (Join-Path $RepoRoot "scripts\resolve-cargo-target.ps1")
#   $bins = Resolve-UsefulReleaseBinaries -RepoRoot $RepoRoot

function Get-UsefulCargoTargetDirectory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $manifest = Join-Path $RepoRoot "Cargo.toml"
    if (-not (Test-Path -LiteralPath $manifest)) {
        throw "Cargo.toml not found at $manifest"
    }

    # Redirect to a file and decode as UTF-8. Capturing cargo stdout through the
    # PowerShell pipeline can corrupt non-ASCII package descriptions and break JSON.
    $outFile = Join-Path ([IO.Path]::GetTempPath()) ("useful-cargo-metadata-" + [Guid]::NewGuid().ToString("N") + ".json")
    $errFile = "$outFile.err"
    try {
        $process = Start-Process -FilePath "cargo" `
            -ArgumentList @("metadata", "--format-version", "1", "--no-deps", "--manifest-path", $manifest) `
            -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $outFile `
            -RedirectStandardError $errFile
        if ($process.ExitCode -ne 0) {
            $errText = ""
            if (Test-Path -LiteralPath $errFile) {
                $errText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($errFile))
            }
            throw "cargo metadata failed (exit $($process.ExitCode)): $errText"
        }

        $jsonText = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($outFile))
        # Prefer a full parse when encoding is intact.
        try {
            $metadata = $jsonText | ConvertFrom-Json
            $targetDir = [string]$metadata.target_directory
        } catch {
            $targetDir = $null
        }

        # Fallback: extract only target_directory (avoids full-document parse issues).
        if ([string]::IsNullOrWhiteSpace($targetDir)) {
            $match = [regex]::Match($jsonText, '"target_directory"\s*:\s*"((?:\\.|[^"\\])*)"')
            if (-not $match.Success) {
                throw "cargo metadata did not include target_directory"
            }
            $escaped = $match.Groups[1].Value
            $targetDir = [regex]::Replace($escaped, '\\u([0-9a-fA-F]{4})', {
                param($m)
                [char][int]("0x" + $m.Groups[1].Value)
            })
            $targetDir = $targetDir.Replace('\\', '\').Replace('\/', '/')
        }

        if ([string]::IsNullOrWhiteSpace($targetDir)) {
            throw "cargo metadata target_directory is empty"
        }
        return [IO.Path]::GetFullPath($targetDir)
    } finally {
        foreach ($path in @($outFile, $errFile)) {
            if (Test-Path -LiteralPath $path) {
                [IO.File]::Delete($path)
            }
        }
    }
}

function Resolve-UsefulReleaseBinaries {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [string]$Profile = "release"
    )

    $targetDir = Get-UsefulCargoTargetDirectory -RepoRoot $RepoRoot
    $profileDir = Join-Path $targetDir $Profile

    # cargo build -p useful-app writes useful-app.exe; tauri build may rename to Useful.exe.
    # Prefer the newest non-empty candidate so a stale renamed Useful.exe cannot mask a fresh cargo build.
    $candidates = @(
        (Join-Path $profileDir "useful-app.exe"),
        (Join-Path $profileDir "Useful.exe")
    )
    $usefulExe = $null
    $bestTime = [DateTime]::MinValue
    foreach ($path in $candidates) {
        $info = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        if ($null -eq $info -or $info.PSIsContainer -or $info.Length -le 0) { continue }
        if ($info.LastWriteTimeUtc -ge $bestTime) {
            $bestTime = $info.LastWriteTimeUtc
            $usefulExe = $info.FullName
        }
    }
    if ([string]::IsNullOrWhiteSpace($usefulExe)) {
        # Default path for error messages when neither exists yet.
        $usefulExe = Join-Path $profileDir "Useful.exe"
    }

    $bootstrapExe = Join-Path $profileDir "useful-bootstrap.exe"

    return [pscustomobject]@{
        TargetDirectory = $targetDir
        ProfileDirectory = $profileDir
        UsefulExe = $usefulExe
        BootstrapExe = $bootstrapExe
    }
}
