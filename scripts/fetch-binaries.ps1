# Fetch and verify the locked ffmpeg, ffprobe, and mpv Windows runtimes.
# Existing binaries and cache entries are never replaced or removed.

$ErrorActionPreference = "Stop"

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

function Ensure-OrdinaryDirectory([string]$directory) {
    if ($null -eq (Get-Item -LiteralPath $directory -Force -ErrorAction SilentlyContinue)) {
        Assert-NoReparsePath (Split-Path $directory -Parent)
        New-Item -ItemType Directory -Path $directory | Out-Null
    }
    Assert-NoReparsePath $directory
    if (-not (Get-Item -LiteralPath $directory).PSIsContainer) { throw "Expected a directory: $directory" }
}

function Assert-TargetAbsent([string]$target) {
    Assert-NoReparsePath (Split-Path $target -Parent)
    if ($null -ne (Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue)) { throw "Refusing to overwrite existing path: $target" }
}

function Assert-ExactProperties($value, [string[]]$expected, [string]$label) {
    if ($null -eq $value) { throw "$label must be an object" }
    $actual = @($value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($expected | Sort-Object)
    if (($actual -join "`n") -ne ($wanted -join "`n")) { throw "$label is not a closed schema" }
}

function Write-NewText([string]$file, [string]$text) {
    $stream = [IO.File]::Open($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally {
        $stream.Dispose()
    }
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Assert-NoReparsePath $repoRoot
$lockPath = Join-Path $PSScriptRoot "media-runtimes.lock.json"
Assert-NoReparsePath $lockPath
$lockInfo = Get-Item -LiteralPath $lockPath
if ($lockInfo.PSIsContainer -or $lockInfo.Length -le 0) { throw "media-runtimes.lock.json must be a non-empty regular file" }
$lock = Get-Content -LiteralPath $lockPath -Raw -Encoding utf8 | ConvertFrom-Json
Assert-ExactProperties $lock @("schemaVersion", "platform", "arch", "archives") "media runtime lock"
if ($lock.schemaVersion -ne "useful.media-runtimes-lock.v1" -or $lock.platform -ne "windows" -or $lock.arch -ne "x64") {
    throw "media runtime lock schema/platform/arch does not match windows/x64"
}

$manifest = @($lock.archives)
if ($manifest.Count -eq 0) { throw "media runtime lock archives must not be empty" }
$archiveIds = @{}
$componentTargets = @{}
$targetNames = @{}
foreach ($item in $manifest) {
    Assert-ExactProperties $item @("id", "name", "version", "license", "sourceUrl", "archiveSha256", "extracts") "media archive"
    if ([string]::IsNullOrWhiteSpace($item.id) -or $archiveIds.ContainsKey($item.id)) { throw "media archive id is missing or duplicated" }
    $archiveIds[$item.id] = $true
    foreach ($field in @("name", "version", "license")) {
        if ([string]::IsNullOrWhiteSpace($item.$field)) { throw "$($item.id) is missing $field" }
    }
    $uri = [Uri]$item.sourceUrl
    if ($uri.Scheme -ne "https" -or [string]::IsNullOrWhiteSpace($uri.Host) -or -not [string]::IsNullOrEmpty($uri.UserInfo) -or -not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw "$($item.id) sourceUrl must be an HTTPS URL without credentials or a fragment"
    }
    if ($item.archiveSha256 -cnotmatch "^[0-9a-f]{64}$") { throw "$($item.id) archiveSha256 must be lowercase SHA-256" }
    $extracts = @($item.extracts)
    if ($extracts.Count -eq 0) { throw "$($item.id) extracts must not be empty" }
    foreach ($extract in $extracts) {
        Assert-ExactProperties $extract @("component", "sourcePath", "targetName") "media extract"
        $normalizedSource = [string]$extract.sourcePath -replace '\\', '/'
        $sourceSegments = $normalizedSource.Split([char]'/', [StringSplitOptions]::None)
        if (
            [string]::IsNullOrWhiteSpace($normalizedSource) -or
            [IO.Path]::IsPathRooted($normalizedSource) -or
            $normalizedSource.StartsWith('/') -or
            $sourceSegments -contains '' -or
            $sourceSegments -contains '..' -or
            $sourceSegments -contains '.'
        ) { throw "Unsafe media extract sourcePath: $($extract.sourcePath)" }
        if ([string]::IsNullOrWhiteSpace($extract.component)) { throw "media extract component is missing" }
        if ([IO.Path]::GetFileName($extract.targetName) -ne $extract.targetName -or -not $extract.targetName.EndsWith(".exe")) {
            throw "media targetName must be an exe basename"
        }
        if ($componentTargets.ContainsKey($extract.component) -or $targetNames.ContainsKey($extract.targetName)) {
            throw "media component or target is duplicated"
        }
        $componentTargets[$extract.component] = $extract.targetName
        $targetNames[$extract.targetName] = $true
    }
}
$expectedPairs = [ordered]@{ ffmpeg = "ffmpeg.exe"; ffprobe = "ffprobe.exe"; mpv = "mpv.exe" }
if ((@($componentTargets.Keys | Sort-Object) -join "`n") -ne (@($expectedPairs.Keys | Sort-Object) -join "`n")) {
    throw "Media component set must be exactly ffmpeg/ffprobe/mpv"
}
foreach ($component in $expectedPairs.Keys) {
    if ($componentTargets[$component] -cne $expectedPairs[$component]) { throw "Media component/target mapping is invalid: $component" }
}

$binDir = Join-Path $repoRoot "binaries"
$cacheRoot = Join-Path $repoRoot "artifacts"
$cacheDownloadRoot = Join-Path $cacheRoot "download-cache"
$cacheDir = Join-Path $cacheDownloadRoot "media"
Ensure-OrdinaryDirectory $binDir
$existingBinaryEntries = @(Get-ChildItem -LiteralPath $binDir -Force)
$existingBinaryNames = @($existingBinaryEntries | ForEach-Object Name | Sort-Object)
$existingBinaryNameText = $existingBinaryNames -join "`n"
if ($existingBinaryNameText -ne "" -and $existingBinaryNameText -ne "README.md") {
    throw "Existing binaries directory entry set is not closed"
}
foreach ($entry in $existingBinaryEntries) {
    Assert-NoReparsePath $entry.FullName
    if ($entry.PSIsContainer -or $entry.Length -le 0) { throw "Existing binaries entry must be a non-empty regular file: $($entry.Name)" }
}
foreach ($name in @("ffmpeg.exe", "ffprobe.exe", "mpv.exe", "CHECKSUMS.txt")) { Assert-TargetAbsent (Join-Path $binDir $name) }
$incompleteMarker = Join-Path $binDir ".useful-fetch-binaries.incomplete.json"
Assert-TargetAbsent $incompleteMarker
Ensure-OrdinaryDirectory $cacheRoot
Ensure-OrdinaryDirectory $cacheDownloadRoot
Ensure-OrdinaryDirectory $cacheDir

$staging = Join-Path $binDir (".staging-" + [Guid]::NewGuid().ToString("N"))
Assert-TargetAbsent $staging
New-Item -ItemType Directory -Path $staging | Out-Null
$stagedOutputs = Join-Path $staging "outputs"
New-Item -ItemType Directory -Path $stagedOutputs | Out-Null
Assert-NoReparsePath $staging
$bitsJobId = $null
$downloadTemp = $null
$deliveryStarted = $false
$movedNames = @()

try {
    foreach ($item in $manifest) {
        $archiveName = [IO.Path]::GetFileName(([Uri]$item.sourceUrl).AbsolutePath)
        if ([string]::IsNullOrWhiteSpace($archiveName)) { throw "Archive URL has no basename: $($item.id)" }
        $cacheFile = Join-Path $cacheDir $archiveName
        $cacheInfo = Get-Item -LiteralPath $cacheFile -Force -ErrorAction SilentlyContinue
        if ($null -ne $cacheInfo) {
            Assert-NoReparsePath $cacheFile
            if ($cacheInfo.PSIsContainer -or $cacheInfo.Length -le 0) { throw "Cached archive is not a non-empty regular file: $archiveName" }
            $cachedHash = (Get-FileHash -LiteralPath $cacheFile -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($cachedHash -cne $item.archiveSha256) { throw "Cached archive hash mismatch; refusing to replace: $archiveName" }
            $archive = $cacheFile
        } else {
            $downloadTemp = Join-Path $cacheDir (".download-" + [Guid]::NewGuid().ToString("N") + ".tmp")
            Assert-TargetAbsent $downloadTemp
            $bitsJob = Start-BitsTransfer -Source $item.sourceUrl -Destination $downloadTemp -DisplayName "Useful media $archiveName" -Asynchronous
            $bitsJobId = $bitsJob.JobId
            $deadline = [DateTime]::UtcNow.AddMinutes(30)
            while ($true) {
                $bitsJob = Get-BitsTransfer -JobId $bitsJobId
                if ($bitsJob.JobState -eq "Transferred") {
                    Complete-BitsTransfer -BitsJob $bitsJob
                    $bitsJobId = $null
                    break
                }
                if ($bitsJob.JobState -in @("Error", "Cancelled")) {
                    $description = $bitsJob.ErrorDescription
                    Remove-BitsTransfer -BitsJob $bitsJob
                    $bitsJobId = $null
                    throw "BITS download failed for $($item.id): $description"
                }
                if ([DateTime]::UtcNow -ge $deadline) {
                    Remove-BitsTransfer -BitsJob $bitsJob
                    $bitsJobId = $null
                    throw "BITS download timed out for $($item.id)"
                }
                Start-Sleep -Seconds 1
            }
            Assert-NoReparsePath $downloadTemp
            $actualArchiveHash = (Get-FileHash -LiteralPath $downloadTemp -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualArchiveHash -cne $item.archiveSha256) { throw "Downloaded archive SHA-256 mismatch for $($item.id)" }
            Assert-TargetAbsent $cacheFile
            Move-Item -LiteralPath $downloadTemp -Destination $cacheFile
            $downloadTemp = $null
            $archive = $cacheFile
        }

        $extractDirectory = Join-Path $staging ("extract-" + $item.id)
        New-Item -ItemType Directory -Path $extractDirectory | Out-Null
        tar -xf $archive -C $extractDirectory
        if ($LASTEXITCODE -ne 0) { throw "Archive extraction failed for $($item.id)" }
        foreach ($extract in $item.extracts) {
            $source = [IO.Path]::GetFullPath((Join-Path $extractDirectory $extract.sourcePath))
            $prefix = $extractDirectory.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
            if (-not $source.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Extracted path escaped staging: $($extract.sourcePath)" }
            Assert-NoReparsePath $source
            $sourceInfo = Get-Item -LiteralPath $source
            if ($sourceInfo.PSIsContainer -or $sourceInfo.Length -le 0) { throw "Extracted runtime is not a non-empty regular file: $($extract.sourcePath)" }
            $destination = Join-Path $stagedOutputs $extract.targetName
            Assert-TargetAbsent $destination
            Move-Item -LiteralPath $source -Destination $destination
        }
    }

    $stagedNames = @(Get-ChildItem -LiteralPath $stagedOutputs -Force | ForEach-Object Name | Sort-Object)
    $expectedTargets = @("ffmpeg.exe", "ffprobe.exe", "mpv.exe")
    if (($stagedNames -join "`n") -ne ($expectedTargets -join "`n")) { throw "Staged media output set is not closed" }
    $checksumLines = @($expectedTargets | ForEach-Object {
        $file = Join-Path $stagedOutputs $_
        Assert-NoReparsePath $file
        "$((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant())  $_"
    })
    Write-NewText (Join-Path $stagedOutputs "CHECKSUMS.txt") (($checksumLines -join "`n") + "`n")
    $closedNames = @(Get-ChildItem -LiteralPath $stagedOutputs -Force | ForEach-Object Name | Sort-Object)
    $expectedClosedNames = @("CHECKSUMS.txt", "ffmpeg.exe", "ffprobe.exe", "mpv.exe")
    if (($closedNames -join "`n") -ne ($expectedClosedNames -join "`n")) { throw "Staged media directory is not closed" }
    $incompleteState = [ordered]@{
        schemaVersion = "useful.media-runtime-delivery.v1"
        status = "incomplete"
        planned = @($expectedClosedNames)
        recovery = "Do not overwrite or delete partial outputs automatically. Inspect the marker and partial files; a rerun fails closed while either remains."
    } | ConvertTo-Json -Compress
    Write-NewText $incompleteMarker "$incompleteState`n"
    $deliveryStarted = $true
    foreach ($name in $expectedClosedNames) {
        $source = Join-Path $stagedOutputs $name
        $destination = Join-Path $binDir $name
        Assert-TargetAbsent $destination
        Move-Item -LiteralPath $source -Destination $destination
        $movedNames += $name
    }
    $finalNames = @(Get-ChildItem -LiteralPath $binDir -Force | ForEach-Object Name | Sort-Object)
    $expectedFinalNames = @($expectedClosedNames)
    if ($existingBinaryNames -contains "README.md") { $expectedFinalNames += "README.md" }
    $expectedFinalNames += ".useful-fetch-binaries.incomplete.json"
    $expectedFinalNames = @($expectedFinalNames | Sort-Object)
    if (($finalNames -join "`n") -ne ($expectedFinalNames -join "`n")) { throw "Incomplete final binaries directory entry set is not closed" }
} catch {
    if ($deliveryStarted) {
        $pendingNames = @($expectedClosedNames | Where-Object { $_ -notin $movedNames })
        [Console]::Error.WriteLine("Incomplete Useful media runtime delivery. moved=[$($movedNames -join ',')] pending=[$($pendingNames -join ',')] marker=$incompleteMarker")
    }
    throw
} finally {
    if ($bitsJobId) {
        Get-BitsTransfer -JobId $bitsJobId -ErrorAction SilentlyContinue | Remove-BitsTransfer -ErrorAction SilentlyContinue
    }
    if ($downloadTemp -and $null -ne (Get-Item -LiteralPath $downloadTemp -Force -ErrorAction SilentlyContinue)) {
        [IO.File]::Delete($downloadTemp)
    }
    if ($null -ne (Get-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue)) {
        [IO.Directory]::Delete($staging, $true)
    }
}

Assert-NoReparsePath $incompleteMarker
[IO.FileInfo]$markerInfo = Get-Item -LiteralPath $incompleteMarker -Force
if ($markerInfo.PSIsContainer -or $markerInfo.Length -le 0) { throw "Incomplete media delivery marker is invalid" }
[IO.File]::Delete($incompleteMarker)
if (Test-Path -LiteralPath $incompleteMarker) { throw "Incomplete media delivery marker cleanup failed" }
$finalNames = @(Get-ChildItem -LiteralPath $binDir -Force | ForEach-Object Name | Sort-Object)
$expectedFinalNames = @($expectedClosedNames)
if ($existingBinaryNames -contains "README.md") { $expectedFinalNames += "README.md" }
$expectedFinalNames = @($expectedFinalNames | Sort-Object)
if (($finalNames -join "`n") -ne ($expectedFinalNames -join "`n")) { throw "Final binaries directory entry set is not closed" }
Write-Host "Useful media runtimes verified and installed."
