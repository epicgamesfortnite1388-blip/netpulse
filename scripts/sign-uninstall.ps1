# Uninstaller signing helper — invoked by NSIS `!uninstfinalize` during the
# package-signed.mjs installer rebuild. NSIS substitutes %1 with the generated
# uninstaller's path, which the define passes as the last argument. Identity
# resolution mirrors scripts/lib/signingIdentity.mjs: thumbprint (store cert)
# first, then Azure Trusted Signing (via signtool — no hardware token), then
# PFX + password (env or the user-only password file). The resolved Azure values
# arrive through the environment because package-signed.mjs exports them to
# makensis, whose `uninstfinalize` command runs this file.
$ErrorActionPreference = 'Stop'
$f = $args[0]
if (-not $f) { throw 'sign-uninstall: no file argument from NSIS' }

$ts = 'http://timestamp.digicert.com'

if ($env:NETPULSE_SIGN_AZURE_DLIB) {
  # Azure Trusted Signing: signtool + the dlib, same profile as the artifacts.
  $signtool = $env:NETPULSE_SIGNTOOL
  if (-not $signtool -or -not (Test-Path $signtool)) { throw 'sign-uninstall: signtool.exe not found (NETPULSE_SIGNTOOL)' }
  $metadata = $env:NETPULSE_SIGN_AZURE_METADATA
  if (-not $metadata -or -not (Test-Path $metadata)) { throw 'sign-uninstall: Azure signing metadata not found' }
  & $signtool sign /v /fd SHA256 /tr $ts /td SHA256 /dlib $env:NETPULSE_SIGN_AZURE_DLIB /dmdf $metadata $f
  if ($LASTEXITCODE -ne 0) { throw ("sign-uninstall: signtool exit " + $LASTEXITCODE) }
  Write-Output ("sign-uninstall: " + (Split-Path $f -Leaf) + " -> azure-trusted-signing")
  exit 0
}

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
  if (-not $pfx -or -not $pw) { throw 'sign-uninstall: no signing identity (thumbprint, Azure dlib, or PFX+password)' }
  $sec = ConvertTo-SecureString $pw -AsPlainText -Force
  $cert = Import-PfxCertificate -FilePath $pfx -Password $sec -CertStoreLocation Cert:\CurrentUser\My
}

# IncludeChain signer: see sign-release.mjs — self-signed roots have no CA
# chain to embed; CA-issued certs validate from the signer cert alone.
$sig = Set-AuthenticodeSignature -FilePath $f -Certificate $cert -IncludeChain signer `
  -TimeStampServer $ts -HashAlgorithm SHA256
# Same rule as scripts/lib/signatureTrust.mjs: PowerShell 5.1 reports a
# self-signed (intact, untrusted-root) signature as UnknownError, and signing DID
# succeed — that is not a failure, but it does mean SmartScreen will warn. Any
# other non-Valid status (HashMismatch, NotSigned, ...) is a real failure.
if ($sig.Status -ne 'Valid') {
  $selfSigned = $sig.SignerCertificate -and ($sig.SignerCertificate.Subject -eq $sig.SignerCertificate.Issuer)
  if ($sig.Status -ne 'UnknownError' -or -not $selfSigned) {
    throw ("sign-uninstall: " + $sig.Status + " " + $sig.StatusMessage)
  }
  Write-Output ("sign-uninstall: " + (Split-Path $f -Leaf) + " -> UnknownError (self-signed chain: signature+timestamp intact, SmartScreen will warn)")
  exit 0
}
Write-Output ("sign-uninstall: " + (Split-Path $f -Leaf) + " -> " + $sig.Status)
