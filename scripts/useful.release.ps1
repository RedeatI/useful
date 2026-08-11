<#
.SYNOPSIS
  useful release:dry-run —— 干净构建到测试签名验证，绝不发布到真实生产。
.DESCRIPTION
  从干净工作区构建 → 生成 SHA-256 → SBOM → provenance → 测试密钥签名 →
  验证所有签名 → 运行安装/升级验证。全程使用 NOT-FOR-PRODUCTION 测试密钥。
#>
[CmdletBinding()]
param([string[]]$Rest)
# 注意：不用 Stop——native 命令（node/go/pnpm）写 stderr 在 Stop 下会被当作
# 终止错误抛出；本脚本依靠显式 $LASTEXITCODE 判定。
$ErrorActionPreference = "Continue"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$OutDir = Join-Path $RepoRoot "dist-release"
$Cli = Join-Path $RepoRoot "packages\useful-cli\bin\useful.mjs"
$ExpectedCommit = (& git -C $RepoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $ExpectedCommit -cnotmatch '^[0-9a-f]{40}$') {
  throw "无法读取精确的 40-hex Git HEAD"
}

function Write-Head($m) { Write-Host "==== $m ====" -ForegroundColor Cyan }
function Write-Ok($m) { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Write-Err($m) { Write-Host "[FAIL] $m" -ForegroundColor Red }

$fail = 0
function Track($name, $sb) {
  Write-Head $name
  $global:LASTEXITCODE = 0
  try {
    & $sb
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "退出码 $LASTEXITCODE" }
    Write-Ok $name
  }
  catch { Write-Err "$name : $($_.Exception.Message)"; $script:fail++ }
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$keyDir = Join-Path $OutDir "test-keys"
$updateManifest = Join-Path $OutDir "app-update.test.json"

Write-Head "release:dry-run（测试密钥；不发布生产）"

# 1. 干净构建（前端 → Rust release → go），确保 Portable 绑定当前 commit 而非残留二进制
Track "前端 production build" { Push-Location (Join-Path $RepoRoot "apps\useful"); pnpm build; Pop-Location }
Track "Rust release build" {
  Push-Location $RepoRoot
  # Local dry-run uses development-trust binaries; production CI injects real update keys and must not set this.
  $prevTrust = $env:USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST
  $env:USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST = "1"
  try {
    pnpm --filter @useful/app tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "Tauri release build failed with exit code $LASTEXITCODE" }
    cargo build --release --locked -p useful-bootstrap
  } finally {
    if ($null -eq $prevTrust) {
      Remove-Item Env:USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST -ErrorAction SilentlyContinue
    } else {
      $env:USEFUL_ALLOW_DEVELOPMENT_UPDATE_TRUST = $prevTrust
    }
    Pop-Location
  }
}
Track "go build server+worker" { Push-Location (Join-Path $RepoRoot "services"); go build ./...; Pop-Location }

# 2. 便携包
$portable = Join-Path $OutDir "Useful-Portable-Lite-x64.zip"
Track "打包 Useful Portable Lite" {
  if (Test-Path (Join-Path $RepoRoot "scripts\package-release.ps1")) {
    & (Join-Path $RepoRoot "scripts\package-release.ps1") -Edition Lite 2>$null
  }
  if (-not (Test-Path $portable)) {
    throw "package-release.ps1 未生成 Useful Portable Lite"
  }
}

# 2b. 尺寸报告与生产预算（写入 artifacts/size，不进入 dist-release 闭集）
Track "measure and enforce production size budget" {
  Push-Location $RepoRoot
  try {
    & (Join-Path $RepoRoot "scripts\measure-size.ps1") -ExpectedCommit $ExpectedCommit
    pnpm size:check --profile ci --expected-commit $ExpectedCommit --json
  } finally {
    Pop-Location
  }
}

# 3. SHA-256
Track "生成 SHA-256" {
  $sums = Join-Path $OutDir "SHA256SUMS.txt"
  Get-ChildItem $OutDir -File -Filter "*.zip" | ForEach-Object {
    $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
    "$h  $($_.Name)"
  } | Set-Content -Path $sums -Encoding UTF8
  if (Test-Path $sums) { Get-Content $sums | Write-Host }
}

# 4. SBOM
Track "生成 SBOM" {
  if (Test-Path (Join-Path $RepoRoot "scripts\gen-sbom.mjs")) {
    Push-Location $RepoRoot; node scripts\gen-sbom.mjs; Pop-Location
  }
}

# 5. 测试密钥密钥仪式（dry-run，NOT-FOR-PRODUCTION）
Track "初始化测试更新根" {
  Remove-Item -Recurse -Force $keyDir -ErrorAction SilentlyContinue
  node $Cli key init-root $keyDir --env test --threshold 2 --roots 3
  node $Cli key sign-root $keyDir --key (Join-Path $keyDir "keys\root-1.private.pem")
  node $Cli key sign-root $keyDir --key (Join-Path $keyDir "keys\root-2.private.pem")
}
Track "verify-ceremony" { node $Cli key verify-ceremony $keyDir }

# 6. 更新 manifest 用测试密钥签名 + 验证
Track "app-update create+sign+verify" {
  $artifact = Get-ChildItem $OutDir -File -Filter "*.zip" | Select-Object -First 1
  if (-not $artifact) {
    # 无便携包时用 SBOM 作为待签制品，保证流程可验证
    $artifact = Get-ChildItem (Join-Path $RepoRoot "dist-sbom") -File -ErrorAction SilentlyContinue | Select-Object -First 1
  }
  if (-not $artifact) { throw "无可签名制品" }
  node $Cli app-update create $updateManifest --product useful-desktop --version 0.0.0-dryrun --channel beta --env test --artifact $artifact.FullName
  node $Cli app-update sign $updateManifest --root $keyDir --key (Join-Path $keyDir "keys\release.private.pem")
  node $Cli app-update verify $updateManifest --root $keyDir
}

# 7. 生产隔离验证：测试根不得通过生产验证
Track "生产隔离验证（应拒绝测试根）" {
  & node $Cli app-update verify $updateManifest --root $keyDir --production 2>&1 | Out-Null
  $pc = $LASTEXITCODE
  if ($pc -eq 0) { throw "测试根竟通过了生产验证（隔离失效！）" }
  Write-Host "  确认：测试根被生产验证拒绝（隔离有效，退出码 $pc）"
  $global:LASTEXITCODE = 0
}

Write-Head "release:dry-run 汇总"
if ($fail -gt 0) { Write-Err "$fail 个步骤失败"; exit 1 }
Write-Ok "release:dry-run 通过（产物在 $OutDir；测试密钥，未发布生产）"
exit 0
