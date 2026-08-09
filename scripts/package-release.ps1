# Package Useful-Portable-Lite-x64.zip, Useful-Portable-Full-x64.zip, or both.
# The caller's existing outputs are never replaced or removed.
# By default only ZIP (+ Full MEDIA-RUNTIMES.json) and SHA256SUMS are delivered;
# expanded portable trees stay in staging unless -KeepExpanded is set.

[CmdletBinding()]
param(
    [ValidateSet("Lite", "Full", "All")]
    [string]$Edition = "Lite",

    [string]$OutDir,

    [switch]$KeepExpanded
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $out = Join-Path $root "dist-release"
} else {
    $out = [IO.Path]::GetFullPath($OutDir)
}

. (Join-Path $PSScriptRoot "resolve-cargo-target.ps1")

function Assert-NoReparsePath([string]$candidate, [bool]$allowMissingLeaf = $false) {
    $full = [IO.Path]::GetFullPath($candidate)
    $pathRoot = [IO.Path]::GetPathRoot($full)
    $relative = $full.Substring($pathRoot.Length)
    $segments = @($relative -split '[\\/]' | Where-Object { $_ -ne "" })
    $cursor = $pathRoot
    for ($index = 0; $index -lt $segments.Count; $index++) {
        $cursor = Join-Path $cursor $segments[$index]
        $info = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($null -eq $info) {
            if ($allowMissingLeaf -and $index -eq $segments.Count - 1) { return }
            throw "Path component is missing: $cursor"
        }
        if ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Path component is a symlink/junction/reparse point: $cursor" }
        if ($index -lt $segments.Count - 1 -and -not $info.PSIsContainer) { throw "Intermediate path component is not a directory: $cursor" }
    }
}

function Assert-OrdinaryFile([string]$file, [string]$label) {
    Assert-NoReparsePath $file
    $info = Get-Item -LiteralPath $file
    if ($info.PSIsContainer -or $info.Length -le 0) { throw "$label must be a non-empty regular file" }
}

function Assert-TargetAbsent([string]$target) {
    Assert-NoReparsePath (Split-Path $target -Parent)
    if ($null -ne (Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue)) {
        throw "Refusing to overwrite existing release output: $target"
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

# .NET Framework / Windows PowerShell 5.1 lacks Path.GetRelativePath; keep portable ZIPs working there.
function Get-PortableRelativePath([string]$baseDir, [string]$fullPath) {
    $baseFull = [IO.Path]::GetFullPath($baseDir).TrimEnd([char]'\', [char]'/')
    $fileFull = [IO.Path]::GetFullPath($fullPath)
    $prefix = $baseFull + [IO.Path]::DirectorySeparatorChar
    if (-not $fileFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside portable directory: $fullPath"
    }
    return $fileFull.Substring($prefix.Length).Replace('\', '/')
}

Assert-NoReparsePath $root
$bins = Resolve-UsefulReleaseBinaries -RepoRoot $root
$exe = $bins.UsefulExe
Assert-OrdinaryFile $exe "Release executable"
$bootstrap = $bins.BootstrapExe
Assert-OrdinaryFile $bootstrap "useful-bootstrap.exe"
$versionMatch = Select-String -Path (Join-Path $root "Cargo.toml") -Pattern '^version = "(.+)"' | Select-Object -First 1
if (-not $versionMatch) { throw "Cargo.toml is missing the workspace version" }
$version = $versionMatch.Matches[0].Groups[1].Value

$requiredDocs = @("LICENSE", "LICENSES.md", "NOTICE", "THIRD_PARTY_NOTICES.md", "TRADEMARKS.md")
foreach ($doc in $requiredDocs) { Assert-OrdinaryFile (Join-Path $root $doc) "Required release document $doc" }

$epochText = $env:SOURCE_DATE_EPOCH
if ([string]::IsNullOrWhiteSpace($epochText)) {
    $epochText = (& git -C $root show -s --format=%ct HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Could not read the git commit timestamp" }
}
if ($epochText -cnotmatch '^(0|[1-9][0-9]*)$') { throw "SOURCE_DATE_EPOCH must be non-negative integer seconds" }
$sourceTimestamp = [DateTimeOffset]::FromUnixTimeSeconds([long]$epochText).ToUniversalTime()
$minimumZipTimestamp = [DateTimeOffset]::Parse("1980-01-01T00:00:00Z")
$maximumZipTimestamp = [DateTimeOffset]::Parse("2107-12-31T23:59:58Z")
if ($sourceTimestamp -lt $minimumZipTimestamp -or $sourceTimestamp -gt $maximumZipTimestamp) {
    throw "SOURCE_DATE_EPOCH is outside the ZIP timestamp range"
}

if ($null -eq (Get-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue)) {
    Assert-NoReparsePath (Split-Path $out -Parent)
    New-Item -ItemType Directory -Path $out | Out-Null
}
Assert-NoReparsePath $out
if (-not (Get-Item -LiteralPath $out).PSIsContainer) { throw "dist-release must be a regular directory" }

# Deliverables: ZIP (+ Full MEDIA-RUNTIMES.json) and checksums by default.
# Expanded portable trees are only moved out of staging when -KeepExpanded is set.
$plannedNames = @()
if ($Edition -in @("Lite", "All")) {
    if ($KeepExpanded) { $plannedNames += "Useful-Portable-Lite-x64" }
    $plannedNames += "Useful-Portable-Lite-x64.zip"
}
if ($Edition -in @("Full", "All")) {
    if ($KeepExpanded) { $plannedNames += "Useful-Portable-Full-x64" }
    $plannedNames += @("Useful-Portable-Full-x64.zip", "MEDIA-RUNTIMES.json")
}
$plannedNames += "SHA256SUMS.txt"
foreach ($name in $plannedNames) { Assert-TargetAbsent (Join-Path $out $name) }
$incompleteMarker = Join-Path $out ".useful-package-release.incomplete.json"
Assert-TargetAbsent $incompleteMarker

$staging = Join-Path $out (".staging-" + [Guid]::NewGuid().ToString("N"))
Assert-TargetAbsent $staging
New-Item -ItemType Directory -Path $staging | Out-Null
Assert-NoReparsePath $staging

function Assert-MediaRuntimes([string]$manifestPath) {
    $binaryRoot = Join-Path $root "binaries"
    Assert-NoReparsePath $binaryRoot
    foreach ($name in @("ffmpeg.exe", "ffprobe.exe", "mpv.exe", "CHECKSUMS.txt")) {
        Assert-OrdinaryFile (Join-Path $binaryRoot $name) "binaries/$name"
    }
    & node (Join-Path $root "scripts\release-metadata-media.mjs") `
        --lock (Join-Path $root "scripts\media-runtimes.lock.json") `
        --binaries $binaryRoot `
        --output $manifestPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Closed media runtime validation failed" }
    Assert-OrdinaryFile $manifestPath "MEDIA-RUNTIMES.json"
}

function New-PortableDirectory([string]$editionName, [bool]$withMedia, [string]$mediaManifestPath) {
    $name = "Useful-Portable-$editionName-x64"
    $directory = Join-Path $staging $name
    New-Item -ItemType Directory -Path $directory | Out-Null
    Copy-Item -LiteralPath $exe -Destination (Join-Path $directory "Useful.exe")
    Copy-Item -LiteralPath $bootstrap -Destination (Join-Path $directory "useful-bootstrap.exe")
    Write-NewText (Join-Path $directory "portable.flag") "" ([Text.UTF8Encoding]::new($false))
    $updateDirectory = Join-Path $directory "update"
    New-Item -ItemType Directory -Path $updateDirectory | Out-Null
    Write-NewText (Join-Path $updateDirectory "current-version.txt") "$version`n" ([Text.Encoding]::ASCII)
    $compatibility = "Product: Useful`nEdition: $editionName`nInternal executable remains Useful.exe for bootstrap/update and shortcut compatibility.`n"
    Write-NewText (Join-Path $directory "COMPATIBILITY.txt") $compatibility ([Text.UTF8Encoding]::new($false))
    foreach ($doc in $requiredDocs) { Copy-Item -LiteralPath (Join-Path $root $doc) -Destination $directory }
    if ($withMedia) {
        $binaryDirectory = Join-Path $directory "binaries"
        New-Item -ItemType Directory -Path $binaryDirectory | Out-Null
        foreach ($name in @("ffmpeg.exe", "ffprobe.exe", "mpv.exe", "CHECKSUMS.txt")) {
            Copy-Item -LiteralPath (Join-Path $root "binaries\$name") -Destination $binaryDirectory
        }
        Copy-Item -LiteralPath $mediaManifestPath -Destination (Join-Path $directory "MEDIA-RUNTIMES.json")
    }
    Assert-NoReparsePath $directory
    return $directory
}

function New-DeterministicZip([string]$directory, [string]$zipPath) {
    Add-Type -AssemblyName System.IO.Compression
    Assert-TargetAbsent $zipPath
    $fileMap = [Collections.Generic.Dictionary[string, IO.FileInfo]]::new([StringComparer]::Ordinal)
    foreach ($file in @(Get-ChildItem -LiteralPath $directory -Recurse -File)) {
        Assert-NoReparsePath $file.FullName
        $relative = Get-PortableRelativePath $directory $file.FullName
        if ($fileMap.ContainsKey($relative)) { throw "Duplicate portable relative path: $relative" }
        $fileMap[$relative] = $file
    }
    if ($fileMap.Count -eq 0) { throw "Portable archive input is empty" }
    $relativePaths = [string[]]$fileMap.Keys
    [Array]::Sort($relativePaths, [StringComparer]::Ordinal)
    $zipFile = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $archive = [IO.Compression.ZipArchive]::new($zipFile, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        $rootName = Split-Path $directory -Leaf
        foreach ($relative in $relativePaths) {
            $file = $fileMap[$relative]
            # Optimal Deflate: primary user-download size win. Reproducibility is
            # validated on a fixed CI runner / PowerShell version with identical unsigned inputs.
            $entry = $archive.CreateEntry("$rootName/$relative", [IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = $sourceTimestamp
            $inputStream = $file.OpenRead()
            $outputStream = $entry.Open()
            try { $inputStream.CopyTo($outputStream) }
            finally { $outputStream.Dispose(); $inputStream.Dispose() }
        }
    } finally {
        $archive.Dispose()
        $zipFile.Dispose()
    }
}

$deliveryStarted = $false
$movedNames = @()
try {
    $zips = @()
    $mediaManifest = Join-Path $staging "MEDIA-RUNTIMES.json"
    if ($Edition -in @("Full", "All")) { Assert-MediaRuntimes $mediaManifest }
    if ($Edition -in @("Lite", "All")) {
        $liteDirectory = New-PortableDirectory "Lite" $false $null
        if (
            (Test-Path -LiteralPath (Join-Path $liteDirectory "binaries")) -or
            (Test-Path -LiteralPath (Join-Path $liteDirectory "MEDIA-RUNTIMES.json"))
        ) {
            throw "Useful Portable Lite must not contain media runtimes or MEDIA-RUNTIMES.json"
        }
        $liteZip = Join-Path $staging "Useful-Portable-Lite-x64.zip"
        New-DeterministicZip $liteDirectory $liteZip
        $zips += $liteZip
    }
    if ($Edition -in @("Full", "All")) {
        $fullDirectory = New-PortableDirectory "Full" $true $mediaManifest
        $fullZip = Join-Path $staging "Useful-Portable-Full-x64.zip"
        New-DeterministicZip $fullDirectory $fullZip
        $zips += $fullZip
    }
    $sumInputs = @($zips)
    if ($Edition -in @("Full", "All")) { $sumInputs += $mediaManifest }
    $sumMap = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
    foreach ($inputFile in $sumInputs) {
        $name = [IO.Path]::GetFileName($inputFile)
        if ($sumMap.ContainsKey($name)) { throw "Duplicate checksum input: $name" }
        $sumMap[$name] = $inputFile
    }
    $sumNames = [string[]]$sumMap.Keys
    [Array]::Sort($sumNames, [StringComparer]::Ordinal)
    $sumLines = @($sumNames | ForEach-Object {
        $hash = Get-FileHash -LiteralPath $sumMap[$_] -Algorithm SHA256
        "$($hash.Hash.ToLowerInvariant())  $_"
    })
    $sums = Join-Path $staging "SHA256SUMS.txt"
    Write-NewText $sums (($sumLines -join "`n") + "`n") ([Text.Encoding]::ASCII)

    $incompleteState = [ordered]@{
        schemaVersion = "useful.local-release-delivery.v1"
        status = "incomplete"
        edition = $Edition
        keepExpanded = [bool]$KeepExpanded
        planned = @($plannedNames)
        recovery = "Do not delete or overwrite existing outputs automatically. Inspect the new partial outputs and marker; a rerun fails closed while either remains."
    } | ConvertTo-Json -Compress
    Write-NewText $incompleteMarker "$incompleteState`n" ([Text.UTF8Encoding]::new($false))
    $deliveryStarted = $true
    foreach ($name in $plannedNames) {
        $source = Join-Path $staging $name
        Assert-NoReparsePath $source
        $destination = Join-Path $out $name
        Assert-TargetAbsent $destination
        Move-Item -LiteralPath $source -Destination $destination
        $movedNames += $name
    }
} catch {
    if ($deliveryStarted) {
        $pendingNames = @($plannedNames | Where-Object { $_ -notin $movedNames })
        [Console]::Error.WriteLine("Incomplete Useful release delivery. moved=[$($movedNames -join ',')] pending=[$($pendingNames -join ',')] marker=$incompleteMarker")
    }
    throw
} finally {
    if ($null -ne (Get-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue)) {
        [IO.Directory]::Delete($staging, $true)
    }
}
if (-not $deliveryStarted) { throw "Release delivery did not start" }
Assert-NoReparsePath $incompleteMarker
[IO.FileInfo]$markerInfo = Get-Item -LiteralPath $incompleteMarker -Force
if ($markerInfo.PSIsContainer -or $markerInfo.Length -le 0) { throw "Incomplete delivery marker is invalid" }
[IO.File]::Delete($incompleteMarker)
if (Test-Path -LiteralPath $incompleteMarker) { throw "Incomplete delivery marker cleanup failed" }
Write-Host "Complete: $out"
Write-Host "Cargo target: $($bins.TargetDirectory)"
Write-Host "KeepExpanded: $([bool]$KeepExpanded)"
