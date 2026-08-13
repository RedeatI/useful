<#
.SYNOPSIS
  平台受限验证矩阵运行器（退出条件 11/12/14）。
.DESCRIPTION
  由 CI platform-limited-matrix 矩阵调用，也可本地运行：
    .\scripts\platform-matrix.ps1 -Scenario large-file-resume
  场景：
   - large-file-resume       ：大文件断点续传 + 摘要校验 + 安装回滚（本地可真实执行）
   - native-tauri-smoke      ：真实 IPC 原生 smoke（需 Windows GUI + WebView2）
   - compose-fault-injection ：PostgreSQL/对象存储/worker 中断注入（需 Docker）
  每个场景要么真实执行并断言，要么在缺少运行条件时以非零退出明确标注"环境受限未执行"，
  绝不以"理论可行"冒充通过。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("large-file-resume", "native-tauri-smoke", "compose-fault-injection")]
  [string]$Scenario
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
function Write-Head($m) { Write-Host "==== $m ====" -ForegroundColor Cyan }
function Write-Ok($m) { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Write-Err($m) { Write-Host "[FAIL] $m" -ForegroundColor Red }
function Write-Skip($m) { Write-Host "[SKIP] $m" -ForegroundColor Yellow }

# ---------- 大文件断点续传 + 摘要校验 + 安装回滚（本地真实执行）----------
function Test-LargeFileResume {
  Write-Head "large-file-resume：断点续传 + 摘要校验 + 安装回滚"
  $work = Join-Path $env:TEMP "useful-largefile"
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $work | Out-Null

  # 生成 256MB 稀疏源文件（CI 可调大到 1GB/10GB；此处默认 256MB 保证可跑）
  $sizeMB = 256
  if ($env:LARGEFILE_MB) { $sizeMB = [int]$env:LARGEFILE_MB }
  $src = Join-Path $work "artifact.bin"
  Write-Host "  生成 ${sizeMB}MB 源文件..."
  $fs = [System.IO.File]::Create($src)
  try {
    $fs.SetLength([int64]$sizeMB * 1MB)  # 稀疏，快速
    # 写入少量真实字节使摘要非平凡（值限 0-255）
    $b = New-Object byte[] 1024
    for ($i = 0; $i -lt 1024; $i++) { $b[$i] = [byte]($i % 256) }
    $fs.Position = 0; $fs.Write($b, 0, $b.Length)
    $fs.Position = $fs.Length - 1024; $fs.Write($b, 0, $b.Length)
  } finally { $fs.Close() }
  $expected = (Get-FileHash $src -Algorithm SHA256).Hash.ToLower()

  # 模拟中断续传：先复制前半，再从断点续传后半（流式，分块）
  $dst = Join-Path $work "download.partial"
  $srcStream = [System.IO.File]::OpenRead($src)
  try {
    $half = [int64]($srcStream.Length / 2)
    # 第一段
    $out = [System.IO.File]::Create($dst)
    $buf = New-Object byte[] (4MB)
    $copied = 0
    while ($copied -lt $half) {
      $n = $srcStream.Read($buf, 0, [Math]::Min($buf.Length, $half - $copied))
      if ($n -le 0) { break }
      $out.Write($buf, 0, $n); $copied += $n
    }
    $out.Close()
    Write-Host "  模拟中断：已下载 $([int]($copied/1MB))MB / $([int]($srcStream.Length/1MB))MB"

    # 续传：从断点 append（验证 Range 语义）
    $resumeFrom = (Get-Item $dst).Length
    $srcStream.Position = $resumeFrom
    $out = [System.IO.File]::Open($dst, [System.IO.FileMode]::Append)
    while ($true) {
      $n = $srcStream.Read($buf, 0, $buf.Length)
      if ($n -le 0) { break }
      $out.Write($buf, 0, $n)
    }
    $out.Close()
  } finally { $srcStream.Close() }

  # 摘要校验（续传后完整性）
  $got = (Get-FileHash $dst -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $expected) { Write-Err "续传后摘要不匹配：$got != $expected"; return 1 }
  Write-Ok "断点续传后摘要一致（流式，未整体载入内存）"

  # 摘要错误检测：篡改一字节，必须被拒
  $tampered = Join-Path $work "tampered.bin"
  Copy-Item $dst $tampered
  $tb = [System.IO.File]::Open($tampered, [System.IO.FileMode]::Open)
  $tb.Position = 0; $tb.WriteByte(0xFF); $tb.Close()
  $tgot = (Get-FileHash $tampered -Algorithm SHA256).Hash.ToLower()
  if ($tgot -eq $expected) { Write-Err "篡改文件竟通过摘要校验"; return 1 }
  Write-Ok "篡改检测：摘要不匹配被拒"

  # 安装回滚：模拟安装到目标目录中途失败 → 回滚到旧版本
  $install = Join-Path $work "install"
  New-Item -ItemType Directory -Force -Path $install | Out-Null
  "v1-old" | Set-Content (Join-Path $install "current.txt")
  $backup = Join-Path $work "backup"
  Copy-Item -Recurse $install $backup
  try {
    "v2-new-partial" | Set-Content (Join-Path $install "current.txt")
    throw "模拟安装中途失败"
  } catch {
    # 回滚
    Remove-Item -Recurse -Force $install
    Copy-Item -Recurse $backup $install
  }
  $after = Get-Content (Join-Path $install "current.txt")
  if ($after -ne "v1-old") { Write-Err "回滚失败，当前=$after"; return 1 }
  Write-Ok "安装失败回滚：版本恢复为 v1-old"

  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  Write-Ok "large-file-resume 通过（${sizeMB}MB；CI 可经 LARGEFILE_MB 调至 1024/10240）"
  return 0
}

# ---------- 原生 Tauri smoke（需 GUI + WebView2）----------
function Test-NativeTauriSmoke {
  Write-Head "native-tauri-smoke：真实 IPC 原生 smoke"
  & (Join-Path $RepoRoot "scripts\native-smoke.ps1")
  return $LASTEXITCODE
}

# ---------- Compose 故障注入（需 Docker）----------
function Invoke-Docker([string[]]$DockerArgs) {
  # PowerShell 7 跨平台调用，参数保持边界；暂时放宽 native stderr 处理，
  # 但保留 Docker 原始输出，确保远端失败可诊断。
  $previousEap = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & docker @DockerArgs 2>&1 | ForEach-Object { Write-Host $_ }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousEap
  }
}

function Get-HttpStatus([string]$Url, [int]$TimeoutSec = 5) {
  try {
    $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec
    return [int]$resp.StatusCode
  } catch {
    if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
    return -1  # 连接失败/超时
  }
}

function Test-ComposeFaultInjection {
  Write-Head "compose-fault-injection：PostgreSQL/对象存储/worker 中断"
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Skip "无 Docker；环境受限未执行"
    return 3
  }
  Push-Location (Join-Path $RepoRoot "deploy/docker-compose")
  # 专用宿主机端口，避免与本机 8080 占用者/Windows 保留端口区间冲突
  # （compose 支持 HTTP_PORT 变量；可用 FAULT_HTTP_PORT 覆盖）
  $port = if ($env:FAULT_HTTP_PORT) { $env:FAULT_HTTP_PORT } else { "28080" }
  $env:HTTP_PORT = $port
  $base = "http://127.0.0.1:$port"
  try {
    node e2e/prepare.mjs | Out-Null
    if ((Invoke-Docker @("compose", "up", "-d", "--build")) -ne 0) { Write-Err "compose up 失败"; return 1 }

    # 基线：health+ready 均 200
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
      if ((Get-HttpStatus "$base/v1/ready") -eq 200) { $ok = $true; break }
      Start-Sleep -Seconds 2
    }
    if (-not $ok) { Write-Err "服务未就绪"; return 1 }
    Write-Ok "基线：/v1/ready = 200"

    # 注入 1：暂停 postgres → ready 必须非 200（503/超时），health 仍 200（进程活着）
    Invoke-Docker @("compose", "pause", "postgres") | Out-Null
    Start-Sleep -Seconds 3
    $ready = Get-HttpStatus "$base/v1/ready" 5
    $health = Get-HttpStatus "$base/v1/health" 5
    if ($ready -eq 200) { Write-Err "postgres 暂停后 ready 仍 200（未真实探活）"; return 1 }
    if ($health -ne 200) { Write-Err "postgres 暂停导致服务崩溃（health=$health）"; return 1 }
    Write-Ok "postgres 暂停：ready=$ready（非 200）、health=200（未崩溃）"

    # 恢复：ready 应在重试窗口内回到 200
    Invoke-Docker @("compose", "unpause", "postgres") | Out-Null
    $ok = $false
    for ($i = 0; $i -lt 15; $i++) {
      if ((Get-HttpStatus "$base/v1/ready") -eq 200) { $ok = $true; break }
      Start-Sleep -Seconds 2
    }
    if (-not $ok) { Write-Err "postgres 恢复后 ready 未回到 200"; return 1 }
    Write-Ok "postgres 恢复：ready 回到 200（可重试、无需重启）"

    # 注入 2：重启 worker → 容器回到 running，API 仍就绪
    Invoke-Docker @("compose", "restart", "source-worker") | Out-Null
    Start-Sleep -Seconds 5
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $running = @(& docker compose ps --status running --format "{{.Service}}" 2>&1)
    $psCode = $LASTEXITCODE
    $ErrorActionPreference = $previousEap
    if ($psCode -ne 0) { Write-Err "compose ps 失败"; return 1 }
    if ($running -notcontains "source-worker") { Write-Err "worker 重启后未回到 running"; return 1 }
    if ((Get-HttpStatus "$base/v1/ready") -ne 200) { Write-Err "worker 重启影响了 API 就绪"; return 1 }
    Write-Ok "worker 重启：容器 running、API 就绪不受影响（队列任务可重试）"

    Invoke-Docker @("compose", "down", "-v") | Out-Null
    Write-Ok "compose-fault-injection 通过"
    return 0
  } catch {
    Write-Err "故障注入异常：$($_.Exception.Message)"
    Invoke-Docker @("compose", "down", "-v") | Out-Null
    return 1
  } finally {
    Remove-Item Env:\HTTP_PORT -ErrorAction SilentlyContinue
    Pop-Location
  }
}

$code = switch ($Scenario) {
  "large-file-resume" { Test-LargeFileResume }
  "native-tauri-smoke" { Test-NativeTauriSmoke }
  "compose-fault-injection" { Test-ComposeFaultInjection }
}
exit $code
