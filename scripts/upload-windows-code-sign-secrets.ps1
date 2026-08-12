# Upload Windows Authenticode PFX into GitHub Actions secrets for Useful release.yml.
# Requires: gh auth login with repo admin; a real code-signing PFX you purchased.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\upload-windows-code-sign-secrets.ps1 `
#     -PfxPath D:\secure\useful-codesign.pfx `
#     -Repo RedeatI/useful
#
# You will be prompted for the PFX password (not echoed). Password is sent only to GitHub secrets API.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PfxPath,

  [string]$Repo = "RedeatI/useful",

  [string]$CertificateSecretName = "WINDOWS_CERTIFICATE_BASE64",

  [string]$PasswordSecretName = "WINDOWS_CERTIFICATE_PASSWORD"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PfxPath)) {
  throw "PFX not found: $PfxPath"
}
$item = Get-Item -LiteralPath $PfxPath
if ($item.PSIsContainer -or $item.Length -le 0) {
  throw "PFX must be a non-empty file"
}

$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) { throw "GitHub CLI (gh) is required" }

Write-Host "Repository: $Repo"
Write-Host "PFX: $($item.FullName) ($([math]::Round($item.Length/1KB,1)) KiB)"
Write-Host ""
Write-Host "Enter the PFX password (input hidden):"
$secure = Read-Host -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if ([string]::IsNullOrEmpty($password)) { throw "Password is empty" }

# Validate PFX opens before upload
try {
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2
  $cert.Import($item.FullName, $password, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::DefaultKeySet)
  Write-Host "Certificate subject: $($cert.Subject)"
  Write-Host "Not after: $($cert.NotAfter.ToUniversalTime().ToString('u'))"
  Write-Host "Has private key: $($cert.HasPrivateKey)"
  if (-not $cert.HasPrivateKey) { throw "PFX has no private key" }
} catch {
  throw "Cannot open PFX with the given password: $($_.Exception.Message)"
}

$bytes = [IO.File]::ReadAllBytes($item.FullName)
$b64 = [Convert]::ToBase64String($bytes)

Write-Host "Uploading $CertificateSecretName ..."
$b64 | & gh secret set $CertificateSecretName --repo $Repo
if ($LASTEXITCODE -ne 0) { throw "Failed to set $CertificateSecretName" }

Write-Host "Uploading $PasswordSecretName ..."
$password | & gh secret set $PasswordSecretName --repo $Repo
if ($LASTEXITCODE -ne 0) { throw "Failed to set $PasswordSecretName" }

Write-Host ""
Write-Host "Done. Secrets set on $Repo."
Write-Host "Re-check gates:"
Write-Host "  node scripts/check-owner-signing-gates.mjs --json"
Write-Host ""
Write-Host "You still need production update trust vars (if not set) and a signed workflow run."
