# Offline MediaPack import with detached Ed25519 verification and atomic activation.
# No production public key is embedded; callers must provide an Owner-approved key.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)][string]$StatementPath,
    [Parameter(Mandatory = $true)][string]$SignatureHex,
    [Parameter(Mandatory = $true)][string]$PublicKeyHex,
    [Parameter(Mandatory = $true)][string]$SourceAssetPath,
    [string]$LockPath,
    [string]$InstallRoot,
    [string]$CurrentUsefulVersion
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($LockPath)) {
    $LockPath = Join-Path $PSScriptRoot "media-runtimes.v2.candidate.lock.json"
}
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw "LOCALAPPDATA is unavailable; pass -InstallRoot" }
    $InstallRoot = Join-Path $env:LOCALAPPDATA "Useful\runtimes\media"
}
if ([string]::IsNullOrWhiteSpace($CurrentUsefulVersion)) {
    $versionMatch = Select-String -Path (Join-Path $repoRoot "Cargo.toml") -Pattern '^version = "(.+)"' | Select-Object -First 1
    if (-not $versionMatch) { throw "Could not resolve current Useful version" }
    $CurrentUsefulVersion = $versionMatch.Matches[0].Groups[1].Value
}
$ArchivePath = [IO.Path]::GetFullPath($ArchivePath)
$ManifestPath = [IO.Path]::GetFullPath($ManifestPath)
$StatementPath = [IO.Path]::GetFullPath($StatementPath)
$SourceAssetPath = [IO.Path]::GetFullPath($SourceAssetPath)
$LockPath = [IO.Path]::GetFullPath($LockPath)
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)

function Assert-NoReparsePath([string]$candidate, [bool]$allowMissingLeaf = $false) {
    $full = [IO.Path]::GetFullPath($candidate)
    $pathRoot = [IO.Path]::GetPathRoot($full)
    $segments = @($full.Substring($pathRoot.Length) -split '[\\/]' | Where-Object { $_ -ne "" })
    $cursor = $pathRoot
    for ($index = 0; $index -lt $segments.Count; $index++) {
        $cursor = Join-Path $cursor $segments[$index]
        $info = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($null -eq $info) {
            if ($allowMissingLeaf -and $index -eq $segments.Count - 1) { return }
            throw "Path component is missing: $cursor"
        }
        if ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Path component is a symlink/junction/reparse point: $cursor"
        }
        if ($index -lt $segments.Count - 1 -and -not $info.PSIsContainer) {
            throw "Intermediate path component is not a directory: $cursor"
        }
    }
}

function Assert-OrdinaryFile([string]$file, [string]$label) {
    Assert-NoReparsePath $file
    $info = Get-Item -LiteralPath $file -Force
    if ($info.PSIsContainer -or $info.Length -le 0) { throw "$label must be a non-empty ordinary file" }
}

function Assert-TargetAbsent([string]$target) {
    Assert-NoReparsePath (Split-Path $target -Parent)
    if ($null -ne (Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue)) {
        throw "Refusing to overwrite existing media runtime path: $target"
    }
}

function Ensure-OrdinaryDirectoryChain([string]$directory) {
    $full = [IO.Path]::GetFullPath($directory)
    $pathRoot = [IO.Path]::GetPathRoot($full)
    $segments = @($full.Substring($pathRoot.Length) -split '[\\/]' | Where-Object { $_ -ne "" })
    $cursor = $pathRoot
    foreach ($segment in $segments) {
        $cursor = Join-Path $cursor $segment
        $info = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($null -eq $info) {
            New-Item -ItemType Directory -Path $cursor | Out-Null
            $info = Get-Item -LiteralPath $cursor -Force
        }
        if (-not $info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Install directory chain contains a non-directory or reparse point: $cursor"
        }
    }
}

function Write-NewText([string]$file, [string]$text, [Text.Encoding]$encoding) {
    $stream = [IO.File]::Open($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = $encoding.GetBytes($text)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally {
        $stream.Dispose()
    }
}

function Get-HexBytesSha256([string]$hex) {
    if ($hex.Length % 2 -ne 0) { throw "Hex byte string length is invalid" }
    $bytes = New-Object byte[] ($hex.Length / 2)
    for ($index = 0; $index -lt $bytes.Length; $index++) {
        $bytes[$index] = [Convert]::ToByte($hex.Substring($index * 2, 2), 16)
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join "") }
    finally { $sha.Dispose() }
}

function Parse-SemVer([string]$value) {
    $match = [regex]::Match($value, '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$')
    if (-not $match.Success) { throw "Invalid SemVer: $value" }
    return [ordered]@{
        major = [int64]$match.Groups[1].Value
        minor = [int64]$match.Groups[2].Value
        patch = [int64]$match.Groups[3].Value
        prerelease = [string]$match.Groups[4].Value
    }
}

function Test-SemVerAtLeast([string]$currentText, [string]$minimumText) {
    $current = Parse-SemVer $currentText
    $minimum = Parse-SemVer $minimumText
    foreach ($field in @("major", "minor", "patch")) {
        if ($current[$field] -gt $minimum[$field]) { return $true }
        if ($current[$field] -lt $minimum[$field]) { return $false }
    }
    if ($current.prerelease -eq $minimum.prerelease) { return $true }
    if ([string]::IsNullOrEmpty($current.prerelease)) { return $true }
    if ([string]::IsNullOrEmpty($minimum.prerelease)) { return $false }
    $left = @($current.prerelease.Split('.'))
    $right = @($minimum.prerelease.Split('.'))
    $count = [Math]::Max($left.Count, $right.Count)
    for ($index = 0; $index -lt $count; $index++) {
        if ($index -ge $left.Count) { return $false }
        if ($index -ge $right.Count) { return $true }
        $leftNumeric = $left[$index] -match '^[0-9]+$'
        $rightNumeric = $right[$index] -match '^[0-9]+$'
        if ($leftNumeric -and $rightNumeric) {
            $leftValue = [uint64]$left[$index]
            $rightValue = [uint64]$right[$index]
            if ($leftValue -gt $rightValue) { return $true }
            if ($leftValue -lt $rightValue) { return $false }
        } elseif ($leftNumeric -ne $rightNumeric) {
            return -not $leftNumeric
        } else {
            $comparison = [StringComparer]::Ordinal.Compare($left[$index], $right[$index])
            if ($comparison -gt 0) { return $true }
            if ($comparison -lt 0) { return $false }
        }
    }
    return $true
}

foreach ($input in @(
    @{ Path = $ArchivePath; Label = "media pack archive" },
    @{ Path = $ManifestPath; Label = "MEDIA-PACK.json" },
    @{ Path = $StatementPath; Label = "MediaPack signing statement" },
    @{ Path = $SourceAssetPath; Label = "GPL corresponding source asset" },
    @{ Path = $LockPath; Label = "v2 media runtime lock" }
)) { Assert-OrdinaryFile $input.Path $input.Label }
Write-Verbose "Input path and key-shape checks passed"
if ($SignatureHex -cnotmatch '^[0-9a-f]{128}$') { throw "SignatureHex must be 64-byte lowercase hex" }
if ($PublicKeyHex -cnotmatch '^[0-9a-f]{64}$') { throw "PublicKeyHex must be 32-byte lowercase hex" }

& node (Join-Path $PSScriptRoot "media-pack-signing.mjs") `
    --statement $StatementPath --signature-hex $SignatureHex --public-key-hex $PublicKeyHex | Out-Null
if ($LASTEXITCODE -ne 0) { throw "MediaPack detached signature verification failed" }
Write-Verbose "Detached signature verified"

$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
$statement = Get-Content -LiteralPath $StatementPath -Raw -Encoding utf8 | ConvertFrom-Json
$packId = [string]$manifest.packId
if ($statement.packId -cne $packId -or $statement.runtimeLockSha256 -cne $manifest.runtimeLockSha256) {
    throw "Signing statement does not bind the selected pack manifest"
}
if (-not (Test-SemVerAtLeast $CurrentUsefulVersion ([string]$statement.minimumUsefulVersion))) {
    throw "Useful $CurrentUsefulVersion is older than media pack minimum $($statement.minimumUsefulVersion)"
}

$archiveInfo = Get-Item -LiteralPath $ArchivePath
$sourceInfo = Get-Item -LiteralPath $SourceAssetPath
$manifestHash = (Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$archiveHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$sourceHash = (Get-FileHash -LiteralPath $SourceAssetPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($manifestHash -cne $statement.manifestSha256) { throw "MEDIA-PACK.json SHA-256 does not match signed statement" }
if ($archiveHash -cne $statement.archiveSha256 -or [int64]$archiveInfo.Length -ne [int64]$statement.archiveSizeBytes) {
    throw "Media pack archive bytes do not match signed statement"
}
if ([IO.Path]::GetFileName($ArchivePath) -cne $statement.archiveFile) { throw "Media pack archive basename does not match signed statement" }
if ([IO.Path]::GetFileName($SourceAssetPath) -cne $statement.correspondingSourceAssetId -or
    $sourceHash -cne $statement.correspondingSourceAssetSha256 -or
    [int64]$sourceInfo.Length -ne [int64]$statement.correspondingSourceAssetSizeBytes) {
    throw "GPL corresponding source asset does not match signed statement"
}
Write-Verbose "Signed archive, manifest, and corresponding-source facts verified"

& node (Join-Path $PSScriptRoot "media-pack-v2.mjs") `
    --lock $LockPath --pack $packId --locked-manifest $ManifestPath | Out-Null
if ($LASTEXITCODE -ne 0) { throw "MEDIA-PACK.json is not bound to the locked component facts" }
Write-Verbose "Manifest matches the v2 locked component facts"

Ensure-OrdinaryDirectoryChain $InstallRoot
$lockDigest = [string]$manifest.runtimeLockSha256
$lockRoot = Join-Path $InstallRoot $lockDigest
Ensure-OrdinaryDirectoryChain $lockRoot
$target = Join-Path $lockRoot $packId
Assert-TargetAbsent $target
Write-Verbose "Versioned target is absent and ready for staging"
$staging = Join-Path $InstallRoot (".staging-" + [Guid]::NewGuid().ToString("N"))
Assert-TargetAbsent $staging
New-Item -ItemType Directory -Path $staging | Out-Null
$payload = Join-Path $staging "payload"
New-Item -ItemType Directory -Path $payload | Out-Null
$targetMoved = $false

try {
    Add-Type -AssemblyName System.IO.Compression
    $expectedRelative = @("MEDIA-PACK.json", "UNSIGNED-CANDIDATE.txt")
    $expectedRelative += @($manifest.components | ForEach-Object { [string]$_.extractedFile })
    $expectedRelative = @($expectedRelative | Sort-Object -Unique)
    $rootName = "Useful-Media-Pack-$packId-windows-x64"
    $archiveStream = [IO.File]::Open($ArchivePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $zip = [IO.Compression.ZipArchive]::new($archiveStream, [IO.Compression.ZipArchiveMode]::Read, $false)
    try {
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($entry in $zip.Entries) {
            $name = [string]$entry.FullName
            if ($name.Contains('\') -or $name.StartsWith('/') -or $name.Contains(':') -or $name.Split('/') -contains '..') {
                throw "Unsafe media pack ZIP entry: $name"
            }
            $prefix = "$rootName/"
            if (-not $name.StartsWith($prefix, [StringComparison]::Ordinal)) { throw "Media pack ZIP root is invalid: $name" }
            $relative = $name.Substring($prefix.Length)
            if ($expectedRelative -cnotcontains $relative -or -not $seen.Add($relative)) {
                throw "Media pack ZIP entry set is not closed: $name"
            }
            $destination = Join-Path $payload $relative
            Assert-TargetAbsent $destination
            $inputStream = $entry.Open()
            $outputStream = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $inputStream.CopyTo($outputStream) }
            finally { $outputStream.Dispose(); $inputStream.Dispose() }
        }
        [string[]]$actual = $seen
        [Array]::Sort($actual, [StringComparer]::Ordinal)
        [string[]]$wanted = $expectedRelative
        [Array]::Sort($wanted, [StringComparer]::Ordinal)
        if (($actual -join "`n") -cne ($wanted -join "`n")) { throw "Media pack ZIP entry set is incomplete" }
    } finally {
        $zip.Dispose()
        $archiveStream.Dispose()
    }

    if ((Get-FileHash -LiteralPath (Join-Path $payload "MEDIA-PACK.json") -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifestHash) {
        throw "Archive MEDIA-PACK.json differs from the signed external manifest"
    }
    foreach ($component in @($manifest.components)) {
        $file = Join-Path $payload ([string]$component.extractedFile)
        Assert-OrdinaryFile $file "installed component $($component.name)"
        $info = Get-Item -LiteralPath $file
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -cne $component.extractedSha256 -or [int64]$info.Length -ne [int64]$component.sizeBytes) {
            throw "Extracted component does not match locked hash/size: $($component.name)"
        }
    }

    Copy-Item -LiteralPath $StatementPath -Destination (Join-Path $payload "MEDIA-PACK-SIGNING.json")
    Write-NewText (Join-Path $payload "MEDIA-PACK-SIGNATURE.hex") "$SignatureHex`n" ([Text.Encoding]::ASCII)
    $publicKeyFingerprint = Get-HexBytesSha256 $PublicKeyHex
    $installed = [ordered]@{
        schemaVersion = "useful.media-pack-installed.v1"
        status = "verified"
        packId = $packId
        runtimeLockSha256 = $lockDigest
        archiveSha256 = $archiveHash
        correspondingSourceAssetId = [string]$statement.correspondingSourceAssetId
        correspondingSourceAssetSha256 = $sourceHash
        mediaPackPublicKeyFingerprint = $publicKeyFingerprint
        installedAtUtc = [DateTime]::UtcNow.ToString("o")
    }
    Write-NewText (Join-Path $payload "INSTALLED.json") (($installed | ConvertTo-Json -Depth 6) + "`n") (New-Object Text.UTF8Encoding($false))
    Move-Item -LiteralPath $payload -Destination $target
    $targetMoved = $true

    $currentPath = Join-Path $InstallRoot "current-$packId.json"
    $currentTemp = Join-Path $InstallRoot (".current-$packId-" + [Guid]::NewGuid().ToString("N") + ".tmp")
    $pointer = [ordered]@{
        schemaVersion = "useful.media-pack-current.v1"
        packId = $packId
        runtimeLockSha256 = $lockDigest
        relativePath = "$lockDigest/$packId"
        mediaPackPublicKeyFingerprint = $publicKeyFingerprint
    }
    Write-NewText $currentTemp (($pointer | ConvertTo-Json -Depth 4) + "`n") (New-Object Text.UTF8Encoding($false))
    $currentInfo = Get-Item -LiteralPath $currentPath -Force -ErrorAction SilentlyContinue
    if ($null -eq $currentInfo) {
        Move-Item -LiteralPath $currentTemp -Destination $currentPath
    } else {
        Assert-OrdinaryFile $currentPath "current media pack pointer"
        $backup = Join-Path $InstallRoot "current-$packId.previous.json"
        if (Test-Path -LiteralPath $backup) { Assert-OrdinaryFile $backup "previous media pack pointer" }
        [IO.File]::Replace($currentTemp, $currentPath, $backup)
    }
    Write-Host "Installed verified media pack '$packId' at $target"
} finally {
    if (Test-Path -LiteralPath $staging) { [IO.Directory]::Delete($staging, $true) }
    if (-not $targetMoved -and (Test-Path -LiteralPath $target)) {
        throw "Unexpected target appeared before verified atomic move: $target"
    }
}
