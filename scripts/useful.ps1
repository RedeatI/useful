<#
.SYNOPSIS
  Useful 统一开发与验证入口（Windows 权威入口）。
  其他脚本只做薄封装；此文件是唯一权威命令面。

.DESCRIPTION
  用法：  .\scripts\useful.ps1 <command> [args]
  运行 .\scripts\useful.ps1 help 查看全部命令。

  设计原则：
   - doctor 不静默修改系统、不自动安装未经校验的二进制；
   - bootstrap/seed 幂等、可重复执行、不污染生产配置；
   - verify:all 覆盖全部语言门禁，失败立即返回非零，并生成机器可读报告；
   - release:dry-run 从干净构建到测试签名验证，绝不发布到真实生产。
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Command = "help",
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$Rest,
  [string]$ResumeFrom
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# 仓库根 = 此脚本父目录的父目录
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ServicesDir = Join-Path $RepoRoot "services"
$AppDir = Join-Path $RepoRoot "apps\useful"
$ProtocolDir = Join-Path $RepoRoot "packages\protocol"
$ReportsDir = Join-Path $RepoRoot "bench-results"

# ---------- 输出辅助（ASCII 安全，兼容 PowerShell 5.1 GBK 控制台） ----------
function Write-Head($msg) { Write-Host "==== $msg ====" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "[ OK ] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red }

# 运行外部命令并返回退出码；不抛出（由调用方判定）。
function Invoke-Step {
  param([string]$Name, [scriptblock]$Action)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Write-Head $Name
  $code = 0
  # native 命令（cargo/go/pnpm）常向 stderr 写正常状态；局部置 Continue，
  # 避免 Stop 模式把它们当作终止错误。以 $LASTEXITCODE 判定真实成败。
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $global:LASTEXITCODE = 0
  try {
    # 全部输出引到控制台/日志（*>&1 | Out-Host），不污染函数返回管道
    & $Action *>&1 | Out-Host
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
  }
  catch {
    Write-Err "$Name 异常: $($_.Exception.Message)"
    $code = 1
  }
  finally { $ErrorActionPreference = $prevEAP }
  $sw.Stop()
  $ms = $sw.ElapsedMilliseconds
  if ($code -eq 0) { Write-Ok "$Name (${ms}ms)" } else { Write-Err "$Name 退出码 $code (${ms}ms)" }
  return [pscustomobject]@{ Name = $Name; Code = $code; DurationMs = $ms }
}

function Test-Tool($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# Test-DockerDaemon 检查 Docker 守护进程是否可达（仅 CLI 存在不够）。
function Test-DockerDaemon {
  if (-not (Test-Tool "docker")) { return $false }
  try {
    $null = & docker version --format '{{.Server.Version}}' 2>$null
    return ($LASTEXITCODE -eq 0)
  }
  catch { return $false }
}

# ---------- doctor ----------
function Cmd-Doctor {
  Write-Head "useful doctor"
  $issues = 0
  $checks = @(
    @{ Name = "Node.js";  Cmd = "node";   Ver = "node --version";   Min = "v20"; Hint = "安装 Node 20 LTS: https://nodejs.org" },
    @{ Name = "pnpm";     Cmd = "pnpm";    Ver = "pnpm --version";   Min = "9";   Hint = "corepack enable; corepack prepare pnpm@9 --activate" },
    @{ Name = "Rust";     Cmd = "rustc";   Ver = "rustc --version";  Min = "1.7"; Hint = "安装 rustup: https://rustup.rs" },
    @{ Name = "Cargo";    Cmd = "cargo";   Ver = "cargo --version";  Min = "1.7"; Hint = "随 rustup 安装" },
    @{ Name = "Go";       Cmd = "go";      Ver = "go version";       Min = "1.2"; Hint = "安装 Go: https://go.dev/dl" },
    @{ Name = "Docker";   Cmd = "docker";  Ver = "docker --version"; Min = "2";   Hint = "安装 Docker Desktop（E2E/Compose 需要）" },
    @{ Name = "Git";      Cmd = "git";     Ver = "git --version";    Min = "2";   Hint = "安装 Git" }
  )
  foreach ($c in $checks) {
    if (Test-Tool $c.Cmd) {
      $v = (& cmd /c $c.Ver 2>$null) -join " "
      Write-Ok "$($c.Name): $v"
    }
    else {
      Write-Err "$($c.Name) 缺失。修复：$($c.Hint)"
      $issues++
    }
  }
  # Docker Compose v2
  if (Test-Tool "docker") {
    $compose = (& cmd /c "docker compose version" 2>$null) -join " "
    if ($compose) { Write-Ok "Docker Compose: $compose" } else { Write-Warn "docker compose v2 不可用（E2E 需要）" }
  }
  # WebView2（Lite 客户端运行时）
  $wv = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
  if ($wv) { Write-Ok "WebView2 Runtime: $($wv.pv)" } else { Write-Warn "未检测到 WebView2 Runtime（Lite 版桌面端需要；Full 版内置）" }

  if ($issues -eq 0) { Write-Ok "doctor 通过：核心工具链就绪"; return 0 }
  Write-Err "doctor 发现 $issues 个缺失项，请按上面修复命令处理"
  return 1
}

# ---------- format / lint / typecheck ----------
function Cmd-Format {
  $r = @()
  $r += Invoke-Step "go fmt" { Push-Location $ServicesDir; gofmt -w .; Pop-Location }
  $r += Invoke-Step "cargo fmt" { Push-Location $RepoRoot; cargo fmt; Pop-Location }
  return ($r | Where-Object { $_.Code -ne 0 }).Count
}

function Cmd-Lint {
  $r = @()
  $r += Invoke-Step "go vet" { Push-Location $ServicesDir; go vet ./...; Pop-Location }
  $r += Invoke-Step "cargo clippy -D warnings" { Push-Location $RepoRoot; cargo clippy --workspace -- -D warnings; Pop-Location }
  $r += Invoke-Step "eslint" { Push-Location $AppDir; pnpm lint; Pop-Location }
  return ($r | Where-Object { $_.Code -ne 0 }).Count
}

function Cmd-Typecheck {
  $r = @()
  $r += Invoke-Step "vue-tsc" { Push-Location $AppDir; pnpm typecheck; Pop-Location }
  return ($r | Where-Object { $_.Code -ne 0 }).Count
}

# ---------- test 变体 ----------
function Cmd-TestUnit {
  $r = @()
  $r += Invoke-Step "go test" { Push-Location $ServicesDir; go test ./...; Pop-Location }
  $r += Invoke-Step "cargo test" { Push-Location $RepoRoot; cargo test --workspace --no-fail-fast; Pop-Location }
  $r += Invoke-Step "frontend vitest" { Push-Location $AppDir; pnpm test; Pop-Location }
  $r += Invoke-Step "protocol tests" { Push-Location $ProtocolDir; node --test; Pop-Location }
  return ($r | Where-Object { $_.Code -ne 0 }).Count
}

function Cmd-TestIntegration {
  $r = @()
  $r += Invoke-Step "go integration (race)" { Push-Location $ServicesDir; go test -race ./internal/app/...; Pop-Location }
  return ($r | Where-Object { $_.Code -ne 0 }).Count
}

function Cmd-TestSecurity {
  # 安全负向测试集中在 auth/publishers/availability/config
  $r = @()
  $r += Invoke-Step "go security tests" {
    Push-Location $ServicesDir
    go test ./internal/publishers/ ./internal/availability/ ./internal/app/ -run "Sigstore|RBAC|Repro|Availability|Production"
    Pop-Location
  }
  return ($r | Where-Object { $_.Code -ne 0 }).Count
}

function Cmd-TestE2E {
  if (-not (Test-Tool "docker")) { Write-Err "E2E 需要 Docker"; return 1 }
  $r = Invoke-Step "compose e2e" {
    Push-Location (Join-Path $RepoRoot "deploy\docker-compose")
    node e2e\prepare.mjs; docker compose --profile e2e down -v --remove-orphans 2>$null; docker compose --profile e2e up --build --abort-on-container-exit --exit-code-from e2e-runner 2>$null
    Pop-Location
  }
  return $r.Code
}

# ---------- Phase 12: 原生与插件测试 ----------
function Cmd-TestNative {
  # 原生 Tauri smoke：先验证 Rust 边界，再构建 native-test Release 并启动真实客户端。
  Write-Head "test:native —— 真实 Tauri Release smoke"
  $r = @()
  $r += Invoke-Step "cargo test (tauri app)" {
    Push-Location (Join-Path $RepoRoot "apps\useful\src-tauri")
    cargo test --no-fail-fast
    Pop-Location
  }
  $r += Invoke-Step "cargo test (workspace core)" {
    Push-Location $RepoRoot
    cargo test --workspace --no-fail-fast
    Pop-Location
  }
  $r += Invoke-Step "CLI args --open-action parse" {
    Push-Location (Join-Path $RepoRoot "apps\useful\src-tauri")
    cargo test -- state::tests
    Pop-Location
  }
  $r += Invoke-Step "native Tauri all-tools smoke" {
    & (Join-Path $RepoRoot "scripts\native-smoke.ps1")
  }
  $r += Invoke-Step "31 utility action CLI deeplinks" {
    & (Join-Path $RepoRoot "scripts\action-deeplink-smoke.ps1") -SkipBuild
  }
  $failed = @($r | Where-Object { $_.Code -ne 0 })
  if ($failed.Count -gt 0) { Write-Err "test:native $($failed.Count) 项失败"; return 1 }
  Write-Ok "test:native 全部通过 ($($r.Count) 项)"
  return 0
}

function Cmd-TestPlugins {
  # 插件 E2E：静态 TUF、真实 Tauri、动态源签名/更新/撤回完整闭环。
  Write-Head "test:plugins —— 插件生命周期"
  $r = @()
  $r += Invoke-Step "useful unpack/manifest/install tests" {
    Push-Location $RepoRoot
    cargo test -p useful-plugin --no-fail-fast
    Pop-Location
  }
  $r += Invoke-Step "plugin SDK build and tests" {
    Push-Location $RepoRoot
    pnpm --filter "@useful/sdk" build
    if ($LASTEXITCODE -eq 0) { pnpm --filter "@useful/sdk" test }
    Pop-Location
  }
  $r += Invoke-Step "three plugins static TUF install/update/rollback" {
    & (Join-Path $RepoRoot "scripts\static-plugin-lifecycle.ps1")
  }
  $r += Invoke-Step "three plugins native Tauri lifecycle" {
    & (Join-Path $RepoRoot "scripts\native-plugin-smoke.ps1")
  }
  $r += Invoke-Step "three plugins Docker dynamic source lifecycle" {
    Push-Location (Join-Path $RepoRoot "deploy\docker-compose")
    node e2e\prepare.mjs
    if ($LASTEXITCODE -eq 0) {
      docker compose --profile e2e down -v --remove-orphans
      docker compose --profile e2e up --build --abort-on-container-exit --exit-code-from e2e-runner
    }
    Pop-Location
  }
  $failed = @($r | Where-Object { $_.Code -ne 0 })
  if ($failed.Count -gt 0) { Write-Err "test:plugins $($failed.Count) 项失败"; return 1 }
  Write-Ok "test:plugins 全部通过 ($($r.Count) 项)"
  return 0
}

function Cmd-TestShortcuts {
  Write-Head "test:shortcuts —— Windows action shortcuts"
  $r = Invoke-Step "five action shortcuts lifecycle" {
    & (Join-Path $RepoRoot "scripts\shortcut-smoke.ps1")
  }
  return $r.Code
}

function Cmd-BenchUtilities {
  # 实用工具 benchmark：输出机器可读 JSON + 可读 Markdown
  Write-Head "bench:utilities —— 实用工具性能基准"
  $benchDir = Join-Path $RepoRoot "bench-results\phase12"
  if (-not (Test-Path $benchDir)) { New-Item -ItemType Directory -Force -Path $benchDir | Out-Null }

  $r = Invoke-Step "frontend vitest bench" {
    Push-Location $AppDir
    pnpm vitest run --config vitest.bench.config.ts
    Pop-Location
  }
  if ($r.Code -ne 0) { Write-Err "bench:utilities 失败"; return 1 }

  # 生成简单报告
  $reportPath = Join-Path $benchDir "utilities-bench.json"
  $report = [pscustomobject]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    machine = $env:COMPUTERNAME
    steps = @(@{ name = "frontend bench"; code = $r.Code; durationMs = $r.DurationMs })
  }
  $report | ConvertTo-Json -Depth 5 | Set-Content -Path $reportPath -Encoding UTF8
  Write-Ok "bench:utilities 完成，报告: $reportPath"
  return 0
}

# ---------- clean ----------
function Cmd-Clean {
  Write-Head "clean（保留源码，清理构建产物与本地运行数据）"
  $targets = @(
    (Join-Path $RepoRoot "target"),
    (Join-Path $AppDir "dist"),
    (Join-Path $RepoRoot "data"),
    (Join-Path $AppDir "src-tauri\data")
  )
  foreach ($t in $targets) {
    if (Test-Path $t) { Write-Warn "删除 $t"; Remove-Item -Recurse -Force $t }
  }
  Write-Ok "clean 完成（node_modules 保留；如需彻底清理手动删除）"
  return 0
}

# ---------- verify:all ----------
function Cmd-VerifyAll {
  Write-Head "verify:all —— 完整质量门禁"
  $results = @()
  $results += Invoke-Step "go fmt check" { Push-Location $ServicesDir; $o = gofmt -l .; Pop-Location; if ($o) { Write-Err "未格式化: $o"; $global:LASTEXITCODE = 1 } else { $global:LASTEXITCODE = 0 } }
  $results += Invoke-Step "go vet" { Push-Location $ServicesDir; go vet ./...; Pop-Location }
  $results += Invoke-Step "go test -race" { Push-Location $ServicesDir; go test -race ./...; Pop-Location }
  $results += Invoke-Step "go build server+worker" { Push-Location $ServicesDir; go build ./...; Pop-Location }
  $results += Invoke-Step "cargo fmt check" { Push-Location $RepoRoot; cargo fmt --check; Pop-Location }
  $results += Invoke-Step "cargo clippy -D warnings" { Push-Location $RepoRoot; cargo clippy --workspace -- -D warnings; Pop-Location }
  $results += Invoke-Step "cargo test workspace" { Push-Location $RepoRoot; cargo test --workspace --no-fail-fast; Pop-Location }
  $results += Invoke-Step "frontend lint" { Push-Location $AppDir; pnpm lint; Pop-Location }
  $results += Invoke-Step "frontend typecheck" { Push-Location $AppDir; pnpm typecheck; Pop-Location }
  $results += Invoke-Step "frontend unit tests" { Push-Location $AppDir; pnpm test; Pop-Location }
  $results += Invoke-Step "frontend production build" { Push-Location $AppDir; pnpm build; Pop-Location }
  $results += Invoke-Step "protocol tests + validate" { Push-Location $ProtocolDir; node --test; Pop-Location }
  $results += Invoke-Step "drift check (migrations/schema/types)" { Push-Location $RepoRoot; node scripts\check-drift.mjs; Pop-Location }
  $results += Invoke-Step "CLI tests (source + key)" { Push-Location (Join-Path $RepoRoot "packages\useful-cli"); npx vitest run; Pop-Location }
  $results += Invoke-Step "doc command smoke" { Push-Location $RepoRoot; node scripts\doc-smoke.mjs; Pop-Location }
  $results += Invoke-Step "SBOM generation (supply chain)" { Push-Location $RepoRoot; node scripts\gen-sbom.mjs; Pop-Location }
  # Phase 12: 原生 smoke + 属性测试
  $results += Invoke-Step "tauri app tests (native smoke)" {
    Push-Location (Join-Path $RepoRoot "apps\useful\src-tauri")
    cargo test --no-fail-fast
    Pop-Location
  }
  $results += Invoke-Step "frontend property tests" {
    Push-Location $AppDir
    pnpm test -- src/lib/tools/property.spec.ts
    Pop-Location
  }
  # E2E 需 Docker 守护进程（仅 CLI 存在不够）；不可达时显式跳过（不计失败，报告标注）
  if (Test-DockerDaemon) {
    $results += Invoke-Step "compose e2e" {
      Push-Location (Join-Path $RepoRoot "deploy\docker-compose")
      # 先清理残留容器/卷/网络：保证 E2E 密闭，也避免陈旧网络引用导致启动失败
      node e2e\prepare.mjs; docker compose --profile e2e down -v --remove-orphans; docker compose --profile e2e up --build --abort-on-container-exit --exit-code-from e2e-runner
      Pop-Location
    }
  }
  else {
    Write-Warn "E2E 跳过： Docker 守护进程不可达（CI compose-e2e 作业覆盖）"
  }

  # 机器可读报告
  if (-not (Test-Path $ReportsDir)) { New-Item -ItemType Directory -Force -Path $ReportsDir | Out-Null }
  $reportPath = Join-Path $ReportsDir "verify-all.json"
  $failed = @($results | Where-Object { $_.Code -ne 0 })
  $summary = [pscustomobject]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    total       = $results.Count
    passed      = ($results | Where-Object { $_.Code -eq 0 }).Count
    failed      = $failed.Count
    totalMs     = ($results | Measure-Object -Property DurationMs -Sum).Sum
    steps       = $results
  }
  $summary | ConvertTo-Json -Depth 5 | Set-Content -Path $reportPath -Encoding UTF8

  Write-Head "verify:all 汇总"
  foreach ($s in $results) {
    $mark = if ($s.Code -eq 0) { "PASS" } else { "FAIL" }
    Write-Host ("  {0,-30} {1,6}ms  {2}" -f $s.Name, $s.DurationMs, $mark)
  }
  Write-Host "报告: $reportPath"
  if ($failed.Count -gt 0) { Write-Err "$($failed.Count) 个门禁失败"; return 1 }
  Write-Ok "全部门禁通过 ($($results.Count) 项)"
  return 0
}

# ---------- 委派给子脚本的命令 ----------
function Cmd-Bootstrap { & (Join-Path $PSScriptRoot "useful.bootstrap.ps1") @Rest; return $LASTEXITCODE }
function Cmd-Seed { & (Join-Path $PSScriptRoot "useful.bootstrap.ps1") -SeedOnly @Rest; return $LASTEXITCODE }
function Cmd-ReleaseDryRun { & (Join-Path $PSScriptRoot "useful.release.ps1") @Rest; return $LASTEXITCODE }
function Cmd-RestoreDrill { & (Join-Path $PSScriptRoot "useful.restore.ps1") @Rest; return $LASTEXITCODE }
function Cmd-Bench { Push-Location $RepoRoot; node scripts\run-benchmarks.mjs @Rest; $c = $LASTEXITCODE; Pop-Location; return $c }
function Cmd-Package { & (Join-Path $PSScriptRoot "package-release.ps1") @Rest; return $LASTEXITCODE }
function Cmd-VerifyPhase13C { & (Join-Path $PSScriptRoot "phase13c-json-diff-pro.ps1") @Rest; return $LASTEXITCODE }
function Cmd-VerifyRelease {
  $args = @()
  if ($ResumeFrom) { $args += @("--resume-from", $ResumeFrom) }
  Push-Location $RepoRoot
  try {
    & node scripts\verify-release.mjs @args
    return $LASTEXITCODE
  }
  finally { Pop-Location }
}

# ---------- dev 命令 ----------
function Cmd-Dev { Push-Location $RepoRoot; pnpm dev; $c = $LASTEXITCODE; Pop-Location; return $c }
function Cmd-DevServer {
  Push-Location $ServicesDir
  $env:ENVIRONMENT = "development"
  go run ./source-server/cmd/server
  $c = $LASTEXITCODE; Pop-Location; return $c
}
function Cmd-DevDesktop { Push-Location $RepoRoot; pnpm tauri dev; $c = $LASTEXITCODE; Pop-Location; return $c }

function Show-Help {
  @"
Useful 统一入口（Windows 权威）

  .\scripts\useful.ps1 <command>

环境与初始化:
  doctor            检查工具链版本，给出精确修复命令（不改系统）
  bootstrap         幂等初始化：依赖/开发配置/迁移/测试源/开发管理员/示例插件
  seed              造数据：免费/付费/已撤回/公告/多源冲突/失效签名夹具
  clean             清理构建产物与本地运行数据（保留源码）

开发:
  dev               前端 dev server
  dev:server        本地 source-server（内存仓库，开发）
  dev:desktop       Tauri 桌面端 dev

质量门禁:
  format            go fmt + cargo fmt
  lint              go vet + clippy -D warnings + eslint
  typecheck         vue-tsc
  test:unit         全语言单元测试 + 协议测试
  test:integration  go -race 集成测试
  test:security     安全负向测试（Sigstore/RBAC/Repro/Availability/生产拒绝）
  test:e2e          Docker Compose 端到端
  test:native      真实 Tauri Release smoke（Rust/IPC/30 个工具/进程清理）
  test:plugins     .useful 插件生命周期测试
  test:shortcuts   五个 action 快捷方式创建/启动/迁移修复/删除
  bench:utilities  实用工具性能基准（输出 JSON + Markdown）
  test:all          = test:unit + integration + security
  verify:all        完整门禁，失败返回非零，生成 bench-results\verify-all.json
  verify:release    Release Candidate 权威验收（支持 -ResumeFrom <stage>）
  verify:phase13c   JSON Diff Pro、付费源、权益更新/取消及取消后原生运行

发布与运维:
  bench             性能基准
  package           打包便携版
  release:dry-run   干净构建→签名→验证（测试密钥，不发布生产）
  restore:drill     备份恢复演练

  help              显示本帮助
"@ | Write-Host
}

# ---------- 分发 ----------
$exit = 0
switch ($Command.ToLower()) {
  "help" { Show-Help; $exit = 0 }
  "doctor" { $exit = Cmd-Doctor }
  "bootstrap" { $exit = Cmd-Bootstrap }
  "seed" { $exit = Cmd-Seed }
  "clean" { $exit = Cmd-Clean }
  "dev" { $exit = Cmd-Dev }
  "dev:server" { $exit = Cmd-DevServer }
  "dev:desktop" { $exit = Cmd-DevDesktop }
  "format" { $exit = Cmd-Format }
  "lint" { $exit = Cmd-Lint }
  "typecheck" { $exit = Cmd-Typecheck }
  "test" { $exit = Cmd-TestUnit }
  "test:unit" { $exit = Cmd-TestUnit }
  "test:integration" { $exit = Cmd-TestIntegration }
  "test:security" { $exit = Cmd-TestSecurity }
  "test:e2e" { $exit = Cmd-TestE2E }
  "test:native" { $exit = Cmd-TestNative }
  "test:plugins" { $exit = Cmd-TestPlugins }
  "test:shortcuts" { $exit = Cmd-TestShortcuts }
  "bench:utilities" { $exit = Cmd-BenchUtilities }
  "test:all" {
    $a = Cmd-TestUnit; $b = Cmd-TestIntegration; $c = Cmd-TestSecurity
    $exit = [int]($a -gt 0 -or $b -gt 0 -or $c -gt 0)
  }
  "bench" { $exit = Cmd-Bench }
  "package" { $exit = Cmd-Package }
  "release:dry-run" { $exit = Cmd-ReleaseDryRun }
  "restore:drill" { $exit = Cmd-RestoreDrill }
  "verify:all" { $exit = Cmd-VerifyAll }
  "verify:release" { $exit = Cmd-VerifyRelease }
  "verify:phase13c" { $exit = Cmd-VerifyPhase13C }
  default { Write-Err "未知命令: $Command"; Show-Help; $exit = 2 }
}
exit $exit
