# Evaluate gyan.dev FFmpeg essentials_build vs current full_build for Useful Full.
# Does NOT mutate production scripts/media-runtimes.lock.json or binaries/.
# Writes artifacts/size/media-essentials-eval.json (+ extracted trees under artifacts/size/media-compare/).

[CmdletBinding()]
param(
    [string]$CacheDir,
    [string]$OutDir,
    [switch]$SkipDownload
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if ([string]::IsNullOrWhiteSpace($CacheDir)) {
    $CacheDir = Join-Path $repoRoot "artifacts\download-cache\media"
}
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $repoRoot "artifacts\size\media-compare"
}
$reportDir = Join-Path $repoRoot "artifacts\size"
foreach ($d in @($CacheDir, $OutDir, $reportDir)) {
    if (-not (Test-Path -LiteralPath $d)) {
        New-Item -ItemType Directory -Path $d | Out-Null
    }
}

# Same version as production full_build pin (8.1.2).
$candidates = @(
    [ordered]@{
        id = "ffmpeg-full-build"
        label = "full_build"
        version = "8.1.2"
        license = "GPLv3"
        archiveName = "ffmpeg-8.1.2-full_build.7z"
        sourceUrl = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-full_build.7z"
        archiveSha256 = "0fff188997a499b5382e0f66e845d4556c48c54f0113ebed4853d556dbdd7059"
        extractRoot = "ffmpeg-8.1.2-full_build/bin"
    },
    [ordered]@{
        id = "ffmpeg-essentials-build"
        label = "essentials_build"
        version = "8.1.2"
        license = "GPLv3"
        archiveName = "ffmpeg-8.1.2-essentials_build.7z"
        sourceUrl = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z"
        archiveSha256 = "e25b682664025d49034c981afb4bae36238a40f29a3cc1c713ad9a8b5b3528f6"
        extractRoot = "ffmpeg-8.1.2-essentials_build/bin"
    }
)

# Product-required software surface (from crates/useful-media ffargs/thumbnail/encoders).
# Hard requirements = product export/thumbnail always needs these.
$requiredEncoders = @(
    "libx264",
    "aac", "libmp3lame", "flac", "pcm_s16le"
)
# Soft requirements = PreciseCut optional codecs; fail = report but may still ship essentials
# with degraded options if hard requirements pass.
$softEncoders = @("libx265", "libsvtav1")
# Decoders: name may be codec id (h264) or library (libdav1d for av1).
$requiredDecoderAny = @{
    h264 = @("h264")
    hevc = @("hevc")
    aac = @("aac")
    mp3 = @("mp3")
    flac = @("flac")
    opus = @("opus")
    vp9 = @("vp9", "libvpx-vp9")
    av1 = @("av1", "libdav1d", "libaom-av1")
}
$requiredFilters = @("scale")
$requiredMuxers = @("mp4", "matroska", "mp3", "flac", "wav", "adts", "ipod")
$optionalHwEncoders = @("h264_nvenc", "hevc_nvenc", "h264_qsv", "hevc_qsv", "h264_amf", "hevc_amf")

function Get-Sha256([string]$path) {
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Ensure-Archive($item) {
    $path = Join-Path $CacheDir $item.archiveName
    if (Test-Path -LiteralPath $path) {
        $hash = Get-Sha256 $path
        if ($hash -cne $item.archiveSha256) {
            throw "Cached archive hash mismatch for $($item.archiveName): $hash"
        }
        Write-Host "Cache hit: $($item.archiveName)"
        return $path
    }
    if ($SkipDownload) {
        throw "Archive missing and -SkipDownload set: $($item.archiveName)"
    }
    Write-Host "Downloading $($item.sourceUrl)"
    $tmp = Join-Path $CacheDir (".download-" + [Guid]::NewGuid().ToString("N") + ".tmp")
    try {
        # curl is more reliable than Invoke-WebRequest for large binary archives on this host.
        & curl.exe -L --fail --retry 3 --connect-timeout 30 -o $tmp $item.sourceUrl
        if ($LASTEXITCODE -ne 0) { throw "curl download failed for $($item.id) (exit $LASTEXITCODE)" }
        $hash = Get-Sha256 $tmp
        if ($hash -cne $item.archiveSha256) {
            throw "Downloaded archive SHA-256 mismatch for $($item.id): $hash"
        }
        Move-Item -LiteralPath $tmp -Destination $path
    } finally {
        if (Test-Path -LiteralPath $tmp) { [IO.File]::Delete($tmp) }
    }
    return $path
}

function Expand-FfmpegCandidate($item, [string]$archivePath) {
    $dest = Join-Path $OutDir $item.label
    if (Test-Path -LiteralPath $dest) {
        [IO.Directory]::Delete($dest, $true)
    }
    New-Item -ItemType Directory -Path $dest | Out-Null
    $extractStaging = Join-Path $OutDir (".extract-" + $item.label)
    if (Test-Path -LiteralPath $extractStaging) {
        [IO.Directory]::Delete($extractStaging, $true)
    }
    New-Item -ItemType Directory -Path $extractStaging | Out-Null
    try {
        tar -xf $archivePath -C $extractStaging
        if ($LASTEXITCODE -ne 0) { throw "tar extract failed for $($item.id)" }
        $binRoot = Join-Path $extractStaging $item.extractRoot
        foreach ($name in @("ffmpeg.exe", "ffprobe.exe")) {
            $src = Join-Path $binRoot $name
            if (-not (Test-Path -LiteralPath $src)) {
                throw "Missing $name in $($item.id) archive under $($item.extractRoot)"
            }
            Copy-Item -LiteralPath $src -Destination (Join-Path $dest $name)
        }
    } finally {
        if (Test-Path -LiteralPath $extractStaging) {
            [IO.Directory]::Delete($extractStaging, $true)
        }
    }
    return $dest
}

function Get-ListedNames([string]$ffmpeg, [string]$kind) {
    # kind: encoders | decoders | filters | muxers
    # Use Start-Process redirect files for PS 5.1 reliability.
    $outFile = Join-Path $env:TEMP ("useful-fflist-" + [Guid]::NewGuid().ToString("N") + ".out")
    $errFile = "$outFile.err"
    try {
        $p = Start-Process -FilePath $ffmpeg `
            -ArgumentList @("-hide_banner", "-$kind") `
            -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $outFile `
            -RedirectStandardError $errFile
        $text = ""
        if (Test-Path -LiteralPath $outFile) {
            $text += [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($outFile))
        }
        if (Test-Path -LiteralPath $errFile) {
            $text += "`n" + [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($errFile))
        }
        $names = @{}
        foreach ($line in ($text -split "`r?`n")) {
            $trim = $line.Trim()
            if ($kind -eq "filters") {
                if ($trim -match '^[A-Z\.]{1,6}\s+([a-zA-Z0-9_]+)\s') {
                    $names[$Matches[1]] = $true
                }
            } elseif ($kind -eq "muxers") {
                if ($trim -match '^[D\s]*E\s+([a-zA-Z0-9_,]+)\s') {
                    foreach ($part in ($Matches[1] -split ',')) {
                        if ($part) { $names[$part] = $true }
                    }
                }
            } else {
                # Flags are 6 chars from {V,A,S,F,X,B,D,.} e.g. "VFS..D h264"
                if ($trim -match '^[A-Z\.]{6}\s+([a-zA-Z0-9_]+)\s') {
                    $names[$Matches[1]] = $true
                }
            }
        }
        return $names
    } finally {
        foreach ($f in @($outFile, $errFile)) {
            if (Test-Path -LiteralPath $f) { [IO.File]::Delete($f) }
        }
    }
}

function Test-CapabilityMatrix([string]$binDir, [string]$label) {
    $ffmpeg = Join-Path $binDir "ffmpeg.exe"
    $ffprobe = Join-Path $binDir "ffprobe.exe"
    $encoders = Get-ListedNames $ffmpeg "encoders"
    $decoders = Get-ListedNames $ffmpeg "decoders"
    $filters = Get-ListedNames $ffmpeg "filters"
    $muxers = Get-ListedNames $ffmpeg "muxers"

    $checks = New-Object System.Collections.ArrayList
    $checkIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    function Add-Check([string]$id, [bool]$ok, [string]$detail) {
        if ([string]::IsNullOrWhiteSpace($id)) { throw "Capability evidence check id must be non-empty" }
        if (-not $checkIds.Add($id)) { throw "Capability evidence check id is duplicated: $id" }
        [void]$checks.Add([ordered]@{ id = $id; ok = $ok; detail = $detail })
    }

    foreach ($name in $requiredEncoders) {
        $hit = $encoders.ContainsKey($name)
        Add-Check "encoder:$name" $hit $(if ($hit) { "present" } else { "MISSING" })
    }
    foreach ($name in $softEncoders) {
        $hit = $encoders.ContainsKey($name)
        Add-Check "soft-encoder:$name" $hit $(if ($hit) { "present" } else { "MISSING (soft)" })
    }
    foreach ($codec in $requiredDecoderAny.Keys) {
        $alts = @($requiredDecoderAny[$codec])
        $hit = $false
        $found = $null
        foreach ($alt in $alts) {
            if ($decoders.ContainsKey($alt)) { $hit = $true; $found = $alt; break }
        }
        Add-Check "decoder:$codec" $hit $(if ($hit) { "present as $found" } else { "MISSING (tried $($alts -join ', '))" })
    }
    foreach ($name in $requiredFilters) {
        $hit = $filters.ContainsKey($name)
        Add-Check "filter:$name" $hit $(if ($hit) { "present" } else { "MISSING" })
    }
    foreach ($name in $requiredMuxers) {
        $hit = $muxers.ContainsKey($name)
        Add-Check "muxer:$name" $hit $(if ($hit) { "present" } else { "MISSING" })
    }
    foreach ($name in $optionalHwEncoders) {
        $hit = $encoders.ContainsKey($name)
        Add-Check "hw-encoder-optional:$name" $true $(if ($hit) { "present" } else { "absent (optional)" })
    }

    $work = Join-Path $OutDir ("work-" + $label)
    if (Test-Path -LiteralPath $work) { [IO.Directory]::Delete($work, $true) }
    New-Item -ItemType Directory -Path $work | Out-Null

    function Invoke-Ffmpeg([string[]]$ffmpegArgs, [string]$checkId) {
        $outFile = Join-Path $work ("run-" + [Guid]::NewGuid().ToString("N") + ".out")
        $errFile = "$outFile.err"
        try {
            $p = Start-Process -FilePath $ffmpeg `
                -ArgumentList $ffmpegArgs `
                -NoNewWindow -Wait -PassThru `
                -RedirectStandardOutput $outFile `
                -RedirectStandardError $errFile
            $err = ""
            if (Test-Path -LiteralPath $errFile) {
                $err = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($errFile)).Trim()
            }
            $ok = ($p.ExitCode -eq 0)
            $detail = "exit=$($p.ExitCode); $err"
            if ($detail.Length -gt 240) { $detail = $detail.Substring(0, 240) }
            Add-Check $checkId $ok $detail
            return $ok
        } finally {
            foreach ($f in @($outFile, $errFile)) {
                if (Test-Path -LiteralPath $f) { [IO.File]::Delete($f) }
            }
        }
    }

    # Generate short test source (color bars + sine).
    $src = Join-Path $work "src.mp4"
    $genOk = Invoke-Ffmpeg @(
        "-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=1",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", $src
    ) "runtime:generate-testsrc-h264-aac"

    if ($genOk -and (Test-Path -LiteralPath $src)) {
        # ffprobe parse
        $probeOut = Join-Path $work "probe.out"
        $probeErr = Join-Path $work "probe.err"
        $pp = Start-Process -FilePath $ffprobe `
            -ArgumentList @("-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", $src) `
            -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $probeOut `
            -RedirectStandardError $probeErr
        $pout = ""
        if (Test-Path -LiteralPath $probeOut) {
            $pout = ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($probeOut))).Trim()
        }
        $probeOk = ($pp.ExitCode -eq 0 -and $pout -match '^[0-9]')
        Add-Check "runtime:ffprobe-duration" $probeOk "duration=$pout exit=$($pp.ExitCode)"

        # Lossless-ish stream copy trim (product LosslessCut path)
        $copyOut = Join-Path $work "copy.mp4"
        Invoke-Ffmpeg @(
            "-hide_banner", "-y", "-ss", "0.1", "-i", $src, "-to", "0.5",
            "-c", "copy", "-map", "0", "-avoid_negative_ts", "make_zero", $copyOut
        ) "runtime:lossless-copy-trim:command" | Out-Null
        Add-Check "runtime:lossless-copy-trim:output" (Test-Path $copyOut) "exists=$(Test-Path $copyOut)"

        # Precise re-encode H.264 software
        $reenc = Join-Path $work "precise.mp4"
        Invoke-Ffmpeg @(
            "-hide_banner", "-y", "-i", $src, "-ss", "0", "-to", "0.5",
            "-c:v", "libx264", "-crf", "23", "-c:a", "aac", $reenc
        ) "runtime:precise-libx264-aac:command" | Out-Null
        Add-Check "runtime:precise-libx264-aac:output" (Test-Path $reenc) "exists=$(Test-Path $reenc)"

        # Audio extract mp3
        $mp3 = Join-Path $work "audio.mp3"
        Invoke-Ffmpeg @(
            "-hide_banner", "-y", "-i", $src, "-vn", "-c:a", "libmp3lame", "-q:a", "2", $mp3
        ) "runtime:audio-libmp3lame:command" | Out-Null
        Add-Check "runtime:audio-libmp3lame:output" (Test-Path $mp3) "exists=$(Test-Path $mp3)"

        # Thumbnail scale filter
        $png = Join-Path $work "thumb.png"
        Invoke-Ffmpeg @(
            "-hide_banner", "-y", "-ss", "0.2", "-i", $src, "-frames:v", "1",
            "-vf", "scale=160:-1", $png
        ) "runtime:thumbnail-scale:command" | Out-Null
        Add-Check "runtime:thumbnail-scale:output" (Test-Path $png) "exists=$(Test-Path $png)"

        # Optional H.265 software if encoder present
        if ($encoders.ContainsKey("libx265")) {
            $hevc = Join-Path $work "hevc.mp4"
            Invoke-Ffmpeg @(
                "-hide_banner", "-y", "-i", $src, "-t", "0.3",
                "-c:v", "libx265", "-crf", "28", "-c:a", "aac", "-tag:v", "hvc1", $hevc
            ) "runtime:libx265:command" | Out-Null
            Add-Check "runtime:libx265:output" (Test-Path $hevc) "exists=$(Test-Path $hevc)"
        } else {
            Add-Check "runtime:libx265:command" $false "encoder missing"
            Add-Check "runtime:libx265:output" $false "skipped"
        }
    } else {
        Add-Check "runtime:ffprobe-duration" $false "skipped (no source)"
        Add-Check "runtime:lossless-copy-trim:command" $false "skipped"
        Add-Check "runtime:lossless-copy-trim:output" $false "skipped"
        Add-Check "runtime:precise-libx264-aac:command" $false "skipped"
        Add-Check "runtime:precise-libx264-aac:output" $false "skipped"
        Add-Check "runtime:audio-libmp3lame:command" $false "skipped"
        Add-Check "runtime:audio-libmp3lame:output" $false "skipped"
        Add-Check "runtime:thumbnail-scale:command" $false "skipped"
        Add-Check "runtime:thumbnail-scale:output" $false "skipped"
        Add-Check "runtime:libx265:command" $false "skipped"
        Add-Check "runtime:libx265:output" $false "skipped"
    }

    $requiredFailed = @($checks | Where-Object {
        -not $_.ok -and (
            $_.id -like "encoder:*" -or
            $_.id -like "decoder:*" -or
            $_.id -like "filter:*" -or
            $_.id -like "muxer:*" -or
            $_.id -like "runtime:*"
        ) -and ($_.id -notlike "runtime:libx265") -and ($_.id -notlike "soft-encoder:*")
    })
    $softFailed = @($checks | Where-Object {
        -not $_.ok -and ($_.id -like "soft-encoder:*" -or $_.id -like "runtime:libx265:*")
    })
    return [ordered]@{
        label = $label
        requiredPassed = ($requiredFailed.Count -eq 0)
        softPassed = ($softFailed.Count -eq 0)
        failedRequired = @($requiredFailed | ForEach-Object { $_.id })
        failedSoft = @($softFailed | ForEach-Object { $_.id })
        checks = @($checks.ToArray())
        encoderCount = $encoders.Count
        decoderCount = $decoders.Count
        filterCount = $filters.Count
        muxerCount = $muxers.Count
    }
}

$results = @()
foreach ($item in $candidates) {
    Write-Host "==== $($item.label) ====" -ForegroundColor Cyan
    $archive = Ensure-Archive $item
    $archiveBytes = (Get-Item -LiteralPath $archive).Length
    $binDir = Expand-FfmpegCandidate $item $archive
    $ffmpegBytes = (Get-Item (Join-Path $binDir "ffmpeg.exe")).Length
    $ffprobeBytes = (Get-Item (Join-Path $binDir "ffprobe.exe")).Length
    $matrix = Test-CapabilityMatrix $binDir $item.label
    $results += [ordered]@{
        id = $item.id
        label = $item.label
        version = $item.version
        license = $item.license
        sourceUrl = $item.sourceUrl
        archiveSha256 = $item.archiveSha256
        archiveBytes = [int64]$archiveBytes
        ffmpegExeBytes = [int64]$ffmpegBytes
        ffprobeExeBytes = [int64]$ffprobeBytes
        totalBinBytes = [int64]($ffmpegBytes + $ffprobeBytes)
        binDir = $binDir
        matrix = $matrix
    }
    Write-Host ("  archive: {0:N2} MB" -f ($archiveBytes / 1MB))
    Write-Host ("  ffmpeg:  {0:N2} MB" -f ($ffmpegBytes / 1MB))
    Write-Host ("  ffprobe: {0:N2} MB" -f ($ffprobeBytes / 1MB))
    Write-Host ("  hard product matrix: {0}; soft codec matrix: {1}" -f `
        $(if ($matrix.requiredPassed) { "PASS" } else { "FAIL [$($matrix.failedRequired -join ', ')]" }), `
        $(if ($matrix.softPassed) { "PASS" } else { "FAIL [$($matrix.failedSoft -join ', ')]" }))
}

$full = $results | Where-Object { $_.label -eq "full_build" } | Select-Object -First 1
$ess = $results | Where-Object { $_.label -eq "essentials_build" } | Select-Object -First 1
$mpvCache = Join-Path $CacheDir "mpv-x86_64-20260610-git-304426c.7z"
$mpvArchiveBytes = if (Test-Path $mpvCache) { [int64](Get-Item $mpvCache).Length } else { $null }

$deltaArchive = if ($full -and $ess) { [int64]$full.archiveBytes - [int64]$ess.archiveBytes } else { $null }
$deltaBins = if ($full -and $ess) { [int64]$full.totalBinBytes - [int64]$ess.totalBinBytes } else { $null }
$essHardOk = [bool]$ess.matrix.requiredPassed
$essSoftOk = [bool]$ess.matrix.softPassed
$fullHardOk = [bool]$full.matrix.requiredPassed

# Rough Full ZIP estimate: Portable Lite (~5.6MB) + media bins with weak Deflate on packed exes.
$estimatedFullZipWithFull = $null
$estimatedFullZipWithEssentials = $null
if ($full -and $ess) {
    $liteZip = 5.6 * 1MB
    $mpvExeCandidates = @(
        (Join-Path $repoRoot "binaries\mpv.exe"),
        "D:\_agents\tools\main\binaries\mpv.exe"
    )
    $mpvExeBytes = $null
    foreach ($p in $mpvExeCandidates) {
        if (Test-Path -LiteralPath $p) { $mpvExeBytes = [int64](Get-Item $p).Length; break }
    }
    if ($null -eq $mpvExeBytes) { $mpvExeBytes = [int64](117.5 * 1MB) }
    $estimatedFullZipWithFull = [int64]($liteZip + 0.92 * ($full.totalBinBytes + $mpvExeBytes))
    $estimatedFullZipWithEssentials = [int64]($liteZip + 0.92 * ($ess.totalBinBytes + $mpvExeBytes))
}

$recommendation = if (-not $essHardOk) {
    "KEEP_FULL_BUILD -- essentials failed hard product matrix; do not switch lock"
} elseif (-not $essSoftOk) {
    "CANDIDATE_ESSENTIALS_WITH_GAPS -- hard paths pass; soft codecs missing (e.g. libx265/libsvtav1). Switch only if product accepts reduced PreciseCut codec menu + Owner GPL gate."
} elseif ($deltaBins -lt (20 * 1MB)) {
    "KEEP_FULL_BUILD -- essentials fully passes but bin savings under 20 MB"
} else {
    "CANDIDATE_ESSENTIALS -- full product matrix pass; switch lock after Owner GPL gate + Full package smoke"
}

$report = [ordered]@{
    schemaVersion = "useful.media-essentials-eval.v1"
    measuredAtUtc = [DateTime]::UtcNow.ToString("o")
    productRequirements = [ordered]@{
        encoders = $requiredEncoders
        decoders = $requiredDecoders
        filters = $requiredFilters
        muxers = $requiredMuxers
        notes = @(
            "LosslessCut: stream copy",
            "PreciseCut: libx264/libx265/libsvtav1 + aac (+ optional nvenc/qsv/amf)",
            "AudioExtract: copy/mp3/aac/flac/wav",
            "Thumbnail: scale filter + png"
        )
    }
    candidates = $results
    comparison = [ordered]@{
        fullArchiveBytes = $full.archiveBytes
        essentialsArchiveBytes = $ess.archiveBytes
        archiveDeltaBytes = $deltaArchive
        fullBinBytes = $full.totalBinBytes
        essentialsBinBytes = $ess.totalBinBytes
        binDeltaBytes = $deltaBins
        mpvArchiveBytes = $mpvArchiveBytes
        estimatedPortableFullZipBytes_fullBuild = $estimatedFullZipWithFull
        estimatedPortableFullZipBytes_essentials = $estimatedFullZipWithEssentials
        essentialsHardMatrixPassed = $essHardOk
        essentialsSoftMatrixPassed = $essSoftOk
        fullHardMatrixPassed = $fullHardOk
    }
    recommendation = $recommendation
    productionLockUnchanged = $true
    notes = @(
        "This evaluation never writes binaries/ or media-runtimes.lock.json.",
        "Full public release remains Owner-gated for GPL corresponding source.",
        "mpv is unchanged; savings come only from ffmpeg/ffprobe build flavor.",
        "Hard matrix = libx264/aac/mp3/flac/pcm + decode h264/hevc/aac/mp3/flac/opus/vp9/av1 + scale + product runtime smokes.",
        "Soft matrix = libx265/libsvtav1 software encode (PreciseCut optional codecs)."
    )
}

# Write candidate lock snippet for review when hard matrix passes (does not activate production).
if ($essHardOk) {
    $candidateLock = [ordered]@{
        schemaVersion = "useful.media-runtimes-lock.v1"
        platform = "windows"
        arch = "x64"
        status = "candidate-not-production"
        recommendation = $recommendation
        archives = @(
            [ordered]@{
                id = "ffmpeg-essentials-build"
                name = "ffmpeg 8.1.2 essentials_build (GPLv3)"
                version = "8.1.2"
                license = "GPLv3"
                sourceUrl = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.7z"
                archiveSha256 = "e25b682664025d49034c981afb4bae36238a40f29a3cc1c713ad9a8b5b3528f6"
                extracts = @(
                    [ordered]@{ component = "ffmpeg"; sourcePath = "ffmpeg-8.1.2-essentials_build/bin/ffmpeg.exe"; targetName = "ffmpeg.exe" },
                    [ordered]@{ component = "ffprobe"; sourcePath = "ffmpeg-8.1.2-essentials_build/bin/ffprobe.exe"; targetName = "ffprobe.exe" }
                )
            },
            [ordered]@{
                id = "mpv"
                name = "mpv 20260610-git-304426c (GPLv2+)"
                version = "20260610-git-304426c"
                license = "GPLv2+"
                sourceUrl = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20260610/mpv-x86_64-20260610-git-304426c.7z"
                archiveSha256 = "facac536baa73c7b925771af5e39a3c9cb16b8d75b59a6e9800de89799dffca7"
                extracts = @(
                    [ordered]@{ component = "mpv"; sourcePath = "mpv.exe"; targetName = "mpv.exe" }
                )
            }
        )
    }
    $candPath = Join-Path $reportDir "media-runtimes.essentials-candidate.lock.json"
    [IO.File]::WriteAllText($candPath, (($candidateLock | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
    Write-Host "Candidate lock (not production): $candPath"
}

$reportPath = Join-Path $reportDir "media-essentials-eval.json"
[IO.File]::WriteAllText($reportPath, (($report | ConvertTo-Json -Depth 10) + "`n"), [Text.UTF8Encoding]::new($false))
Write-Host ""
Write-Host "Report: $reportPath" -ForegroundColor Green
Write-Host ("Full archive:       {0:N1} MB" -f ($full.archiveBytes / 1MB))
Write-Host ("Essentials archive: {0:N1} MB" -f ($ess.archiveBytes / 1MB))
Write-Host ("Bin delta (ffmpeg+ffprobe): {0:N1} MB" -f ($deltaBins / 1MB))
Write-Host ("Estimated Full ZIP full_build:   {0:N1} MB" -f ($estimatedFullZipWithFull / 1MB))
Write-Host ("Estimated Full ZIP essentials:   {0:N1} MB" -f ($estimatedFullZipWithEssentials / 1MB))
Write-Host "Recommendation: $recommendation"
if (-not $essHardOk) { exit 2 }
if (-not $essSoftOk) { exit 3 }
exit 0
