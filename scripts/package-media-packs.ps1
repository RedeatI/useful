# Build deterministic, unsigned media-pack v2 candidates from an already verified
# ffmpeg/ffprobe/mpv binary set. These artifacts are NOT public Release assets.

[CmdletBinding()]
param(
    [string]$LockPath,
    [string]$BinariesDir,
    [string]$OutDir
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($LockPath)) {
    $LockPath = Join-Path $PSScriptRoot "media-runtimes.v2.candidate.lock.json"
}
if ([string]::IsNullOrWhiteSpace($BinariesDir)) {
    $BinariesDir = Join-Path $root "binaries"
}
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $root "artifacts\size\media-packs-candidate"
}
$LockPath = [IO.Path]::GetFullPath($LockPath)
$BinariesDir = [IO.Path]::GetFullPath($BinariesDir)
$OutDir = [IO.Path]::GetFullPath($OutDir)

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
    if ($info.PSIsContainer -or $info.Length -le 0) { throw "$label must be a non-empty regular file" }
}

function Assert-TargetAbsent([string]$target) {
    Assert-NoReparsePath (Split-Path $target -Parent)
    if ($null -ne (Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue)) {
        throw "Refusing to overwrite existing media-pack output: $target"
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

function Get-RelativePathCompat([string]$baseDir, [string]$fullPath) {
    $baseFull = [IO.Path]::GetFullPath($baseDir).TrimEnd([char]'\', [char]'/')
    $fileFull = [IO.Path]::GetFullPath($fullPath)
    $prefix = $baseFull + [IO.Path]::DirectorySeparatorChar
    if (-not $fileFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside media pack directory: $fullPath"
    }
    return $fileFull.Substring($prefix.Length).Replace('\', '/')
}

function New-DeterministicZip([string]$directory, [string]$zipPath, [DateTimeOffset]$timestamp) {
    Add-Type -AssemblyName System.IO.Compression
    Assert-TargetAbsent $zipPath
    $fileMap = [Collections.Generic.Dictionary[string, IO.FileInfo]]::new([StringComparer]::Ordinal)
    foreach ($file in @(Get-ChildItem -LiteralPath $directory -Recurse -File -Force)) {
        Assert-NoReparsePath $file.FullName
        $relative = Get-RelativePathCompat $directory $file.FullName
        if ($fileMap.ContainsKey($relative)) { throw "Duplicate media-pack relative path: $relative" }
        $fileMap[$relative] = $file
    }
    if ($fileMap.Count -eq 0) { throw "Media-pack archive input is empty" }
    $relativePaths = [string[]]$fileMap.Keys
    [Array]::Sort($relativePaths, [StringComparer]::Ordinal)
    $zipFile = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $archive = [IO.Compression.ZipArchive]::new($zipFile, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        $rootName = Split-Path $directory -Leaf
        foreach ($relative in $relativePaths) {
            $entry = $archive.CreateEntry("$rootName/$relative", [IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = $timestamp
            $inputStream = $fileMap[$relative].OpenRead()
            $outputStream = $entry.Open()
            try { $inputStream.CopyTo($outputStream) }
            finally { $outputStream.Dispose(); $inputStream.Dispose() }
        }
    } finally {
        $archive.Dispose()
        $zipFile.Dispose()
    }
}

Assert-NoReparsePath $root
Assert-OrdinaryFile $LockPath "v2 media runtime lock"
Assert-NoReparsePath $BinariesDir
if (-not (Get-Item -LiteralPath $BinariesDir -Force).PSIsContainer) { throw "BinariesDir must be a directory" }

if ($null -eq (Get-Item -LiteralPath $OutDir -Force -ErrorAction SilentlyContinue)) {
    Assert-NoReparsePath (Split-Path $OutDir -Parent)
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}
Assert-NoReparsePath $OutDir
if (-not (Get-Item -LiteralPath $OutDir -Force).PSIsContainer) { throw "OutDir must be a directory" }

$lock = Get-Content -LiteralPath $LockPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($lock.schemaVersion -cne "useful.media-runtimes-lock.v2") { throw "Only the v2 candidate lock is accepted" }
$packs = @($lock.packs)
if ($packs.Count -eq 0) { throw "v2 candidate lock packs must not be empty" }

$epochText = $env:SOURCE_DATE_EPOCH
if ([string]::IsNullOrWhiteSpace($epochText)) {
    $epochText = (& git -C $root show -s --format=%ct HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Could not read the git commit timestamp" }
}
if ($epochText -cnotmatch '^(0|[1-9][0-9]*)$') { throw "SOURCE_DATE_EPOCH must be non-negative integer seconds" }
$sourceTimestamp = [DateTimeOffset]::FromUnixTimeSeconds([long]$epochText).ToUniversalTime()
if ($sourceTimestamp -lt [DateTimeOffset]::Parse("1980-01-01T00:00:00Z") -or
    $sourceTimestamp -gt [DateTimeOffset]::Parse("2107-12-31T23:59:58Z")) {
    throw "SOURCE_DATE_EPOCH is outside the ZIP timestamp range"
}

$plannedNames = @($packs | ForEach-Object {
    "MEDIA-PACK-$($_.id).unsigned-candidate.json"
    "Useful-Media-Pack-$($_.id)-windows-x64-unsigned-candidate.zip"
})
$plannedNames += "MEDIA-PACKS-CANDIDATE-SHA256SUMS.txt"
foreach ($name in $plannedNames) { Assert-TargetAbsent (Join-Path $OutDir $name) }
$incompleteMarker = Join-Path $OutDir ".useful-media-pack-candidate.incomplete.json"
Assert-TargetAbsent $incompleteMarker

$staging = Join-Path $OutDir (".staging-" + [Guid]::NewGuid().ToString("N"))
Assert-TargetAbsent $staging
New-Item -ItemType Directory -Path $staging | Out-Null
Assert-NoReparsePath $staging
$deliveryStarted = $false
$movedNames = @()

try {
    $runtimeManifest = Join-Path $staging "MEDIA-RUNTIMES.json"
    & node (Join-Path $PSScriptRoot "release-metadata-media.mjs") `
        --lock $LockPath --binaries $BinariesDir --output $runtimeManifest | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "v2 runtime manifest generation failed" }
    Assert-OrdinaryFile $runtimeManifest "MEDIA-RUNTIMES.json"

    $runtime = Get-Content -LiteralPath $runtimeManifest -Raw -Encoding utf8 | ConvertFrom-Json
    $runtimeByName = @{}
    foreach ($component in @($runtime.components)) { $runtimeByName[[string]$component.name] = $component }
    $zipPaths = @()
    $deliveredManifestPaths = @()
    foreach ($pack in $packs) {
        $packId = [string]$pack.id
        $packRootName = "Useful-Media-Pack-$packId-windows-x64"
        $packRoot = Join-Path $staging $packRootName
        New-Item -ItemType Directory -Path $packRoot | Out-Null
        $packManifest = Join-Path $packRoot "MEDIA-PACK.json"
        & node (Join-Path $PSScriptRoot "media-pack-v2.mjs") `
            --lock $LockPath --runtime-manifest $runtimeManifest --pack $packId --output $packManifest | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Media-pack manifest generation failed: $packId" }
        Assert-OrdinaryFile $packManifest "MEDIA-PACK.json ($packId)"
        $deliveredManifest = Join-Path $staging "MEDIA-PACK-$packId.unsigned-candidate.json"
        Copy-Item -LiteralPath $packManifest -Destination $deliveredManifest
        $deliveredManifestPaths += $deliveredManifest
        foreach ($componentName in @($pack.components)) {
            $component = $runtimeByName[[string]$componentName]
            if ($null -eq $component) { throw "Runtime manifest is missing pack component: $componentName" }
            $source = Join-Path $BinariesDir ([string]$component.extractedFile)
            Assert-OrdinaryFile $source "pack component $componentName"
            Copy-Item -LiteralPath $source -Destination (Join-Path $packRoot ([string]$component.extractedFile))
        }
        Write-NewText (Join-Path $packRoot "UNSIGNED-CANDIDATE.txt") `
            "This media pack is unsigned and is not approved for public distribution or in-app installation.`n" `
            (New-Object Text.UTF8Encoding($false))
        $zipName = "Useful-Media-Pack-$packId-windows-x64-unsigned-candidate.zip"
        $zipPath = Join-Path $staging $zipName
        New-DeterministicZip $packRoot $zipPath $sourceTimestamp
        $zipPaths += $zipPath
    }

    [string[]]$sumInputs = @($zipPaths) + @($deliveredManifestPaths)
    [Array]::Sort($sumInputs, [StringComparer]::Ordinal)
    $sumLines = @($sumInputs | ForEach-Object {
        "$((Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($_))"
    })
    Write-NewText (Join-Path $staging "MEDIA-PACKS-CANDIDATE-SHA256SUMS.txt") `
        (($sumLines -join "`n") + "`n") ([Text.Encoding]::ASCII)

    $state = [ordered]@{
        schemaVersion = "useful.media-pack-candidate-delivery.v1"
        status = "incomplete"
        planned = @($plannedNames)
        publicRelease = $false
        recovery = "Inspect partial outputs and marker. Never publish unsigned candidates; reruns fail closed while outputs remain."
    } | ConvertTo-Json -Compress
    Write-NewText $incompleteMarker "$state`n" (New-Object Text.UTF8Encoding($false))
    $deliveryStarted = $true
    foreach ($name in $plannedNames) {
        $source = Join-Path $staging $name
        Assert-NoReparsePath $source
        $destination = Join-Path $OutDir $name
        Assert-TargetAbsent $destination
        Move-Item -LiteralPath $source -Destination $destination
        $movedNames += $name
    }
} catch {
    if ($deliveryStarted) {
        $pending = @($plannedNames | Where-Object { $_ -notin $movedNames })
        [Console]::Error.WriteLine("Incomplete Useful media-pack candidate delivery. moved=[$($movedNames -join ',')] pending=[$($pending -join ',')] marker=$incompleteMarker")
    }
    throw
} finally {
    if ($null -ne (Get-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue)) {
        [IO.Directory]::Delete($staging, $true)
    }
}

if (-not $deliveryStarted) { throw "Media-pack candidate delivery did not start" }
Assert-OrdinaryFile $incompleteMarker "media-pack incomplete marker"
[IO.File]::Delete($incompleteMarker)
if (Test-Path -LiteralPath $incompleteMarker) { throw "Media-pack incomplete marker cleanup failed" }
foreach ($name in $plannedNames) {
    Assert-OrdinaryFile (Join-Path $OutDir $name) "completed media-pack candidate $name"
}
Write-Host "Unsigned media-pack v2 candidates complete: $OutDir"
