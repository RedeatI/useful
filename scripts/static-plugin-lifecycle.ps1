<#
.SYNOPSIS
  Generate a signed two-version static source and run the three-plugin client lifecycle.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$artifactDir = Join-Path $RepoRoot "artifacts\plugin-static-lifecycle\$timestamp"
$fixturePath = Join-Path $artifactDir "fixture.json"
$exitCode = 1

try {
  New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
  Push-Location $RepoRoot
  try {
    & node "scripts\prepare-plugin-static-lifecycle.mjs" $artifactDir
    if ($LASTEXITCODE -ne 0) { throw "static lifecycle fixture generation failed: $LASTEXITCODE" }
    $env:USEFUL_PLUGIN_LIFECYCLE_FIXTURE = $fixturePath
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & cargo test -p useful-app --test plugin_static_lifecycle -- --nocapture
    $cargoCode = $LASTEXITCODE
    $ErrorActionPreference = $previousEap
    if ($cargoCode -ne 0) { throw "static lifecycle client test failed: $cargoCode" }
  } finally {
    $ErrorActionPreference = "Stop"
    Remove-Item Env:USEFUL_PLUGIN_LIFECYCLE_FIXTURE -ErrorAction SilentlyContinue
    Pop-Location
  }
  [ordered]@{
    scenario = "three-plugin-static-tuf-lifecycle"
    passed = $true
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    fixture = $fixturePath
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $artifactDir "result.json") -Encoding UTF8
  Write-Host "[ OK ] static plugin lifecycle"
  Write-Host "Evidence: $artifactDir"
  $exitCode = 0
} catch {
  [ordered]@{
    scenario = "three-plugin-static-tuf-lifecycle"
    passed = $false
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    error = $_.Exception.Message
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $artifactDir "result.json") -Encoding UTF8
  Write-Error $_
  $exitCode = 1
}

exit $exitCode
