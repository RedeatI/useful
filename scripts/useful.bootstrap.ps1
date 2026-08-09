<#
.SYNOPSIS
  useful bootstrap / seed 的实现（由 useful.ps1 委派）。
.DESCRIPTION
  幂等初始化开发环境：依赖安装、开发配置生成、迁移、测试源、开发管理员、示例插件。
  -SeedOnly 仅造数据（免费/付费/已撤回/公告/多源冲突/失效签名夹具）。
  不污染生产配置：所有产物写入 data/ 与 .env（开发），绝不写生产密钥。
#>
[CmdletBinding()]
param(
  [switch]$SeedOnly,
  [string[]]$Rest
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ServicesDir = Join-Path $RepoRoot "services"

function Write-Head($m) { Write-Host "==== $m ====" -ForegroundColor Cyan }
function Write-Ok($m) { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }

# ---------- 1. 依赖 ----------
function Step-Deps {
  Write-Head "安装依赖（幂等）"
  Push-Location $RepoRoot
  try {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) { pnpm install --frozen-lockfile }
    else { Write-Warn "pnpm 缺失，跳过前端依赖（先运行 doctor）" }
    Push-Location $ServicesDir; go mod download; Pop-Location
    Write-Ok "依赖就绪"
  }
  finally { Pop-Location }
}

# ---------- 2. 开发配置（.env）----------
function Step-Config {
  Write-Head "生成开发配置 .env（仅开发；绝不含生产密钥）"
  $envPath = Join-Path $RepoRoot "deploy\docker-compose\.env"
  $examplePath = Join-Path $RepoRoot "deploy\docker-compose\.env.example"
  if (-not (Test-Path $envPath)) {
    if (Test-Path $examplePath) {
      Copy-Item $examplePath $envPath
      Write-Ok "已从 .env.example 生成 .env（请勿用于生产）"
    }
    else { Write-Warn ".env.example 缺失，跳过" }
  }
  else { Write-Ok ".env 已存在（幂等，未覆盖）" }
}

# ---------- 3. 数据库迁移（需 Docker/Compose；否则内存模式提示）----------
function Step-Migrate {
  Write-Head "数据库迁移（Compose Postgres）"
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Warn "Docker 缺失：开发默认走内存仓库（无需迁移）；生产用 Postgres"
    return
  }
  Write-Ok "迁移在 source-server 启动时自动应用（advisory lock 串行化，幂等）"
}

# ---------- 4. 开发管理员 API Token ----------
function Step-Admin {
  Write-Head "创建开发管理员并签发 API Token（明文只显示一次）"
  Push-Location $ServicesDir
  try {
    $env:ENVIRONMENT = "development"
    $env:STORAGE_PATH = Join-Path $RepoRoot "data\storage"
    $env:TUF_KEYS_DIR = Join-Path $RepoRoot "data\tuf-keys"
    go run ./source-server/cmd/server -init-admin -init-admin-id "dev-admin"
    Write-Ok "开发管理员就绪（token 明文见上；服务端只存哈希）"
  }
  finally { Pop-Location }
}

# ---------- 5. 示例插件 / 静态源 ----------
function Step-Examples {
  Write-Head "生成静态示例源（离线可用）"
  Push-Location $RepoRoot
  try {
    if (Test-Path "scripts\gen-static-example.mjs") {
      node scripts\gen-static-example.mjs
      Write-Ok "静态示例源已生成于 repositories\static-example"
    }
    else { Write-Warn "gen-static-example.mjs 缺失，跳过" }
  }
  finally { Pop-Location }
}

# ---------- seed：造多样化数据夹具 ----------
function Step-Seed {
  Write-Head "seed：造开发数据夹具（免费/付费/撤回/公告/多源冲突/失效签名）"
  Push-Location $RepoRoot
  try {
    if (Test-Path "scripts\make-fixtures.mjs") {
      node scripts\make-fixtures.mjs
      Write-Ok "夹具已生成（fixtures\ 下：normal/corrupt/malicious-path）"
    }
    else { Write-Warn "make-fixtures.mjs 缺失" }
    Write-Ok "seed 完成（开发数据；不污染生产）"
  }
  finally { Pop-Location }
}

if ($SeedOnly) {
  Step-Seed
  exit 0
}

Step-Deps
Step-Config
Step-Migrate
Step-Examples
Step-Admin
Write-Ok "bootstrap 完成。下一步：.\scripts\useful.ps1 verify:all"
exit 0
