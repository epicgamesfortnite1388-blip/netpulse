# Uninstaller signing helper — invoked by NSIS `!uninstfinalize` during the
# package-signed.mjs installer rebuild. NSIS appends the generated
# uninstaller's path as the last argument. Identity resolution mirrors
# sign-release.mjs: thumbprint (store cert) first, then PFX + password
# (env or the user-only password file).
$ErrorActionPreference = 'Stop'
$f = $args[0]
if (-not $f) { throw 'sign-uninstall: no file argument from NSIS' }

$cert = $null
if ($env:NETPULSE_SIGN_THUMBPRINT) {
  $cert = Get-ChildItem ("Cert:\CurrentUser\My\" + $env:NETPULSE_SIGN_THUMBPRINT) -ErrorAction Stop
} else {
  $pfx = $env:NETPULSE_SIGN_PFX
  $pw = $env:NETPULSE_SIGN_PFX_PASSWORD
  if (-not $pw -and $pfx) {
    $pwFile = Join-Path $env:USERPROFILE '.netpulse-signing-pw'
    if (Test-Path $pwFile) { $pw = (Get-Content $pwFile -ErrorAction Stop | Select-Object -First 1) }
  }
  if (-not $pfx -or -not $pw) { throw 'sign-uninstall: no signing identity (thumbprint or PFX+password)' }
  $sec = ConvertTo-SecureString $pw -AsPlainText -Force
  $cert = Import-PfxCertificate -FilePath $pfx -Password $sec -CertStoreLocation Cert:\CurrentUser\My
}

# IncludeChain signer: see sign-release.mjs — self-signed roots have no CA
# chain to embed; CA-issued certs validate from the signer cert alone.
$sig = Set-AuthenticodeSignature -FilePath $f -Certificate $cert -IncludeChain signer `
  -TimeStampServer 'http://timestamp.digicert.com' -HashAlgorithm SHA256
if ($sig.Status -ne 'Valid') { throw ("sign-uninstall: " + $sig.Status + " " + $sig.StatusMessage) }
Write-Output ("sign-uninstall: " + (Split-Path $f -Leaf) + " -> " + $sig.Status)
